const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createSessionStore } = require('../src/session-store');
const { createStateCenter } = require('../src/state-center');
const { createReferenceLibrary } = require('../src/reference-library');
const { createSessionReset } = require('../src/session-reset');
const { createConversationCommands } = require('../src/conversation-commands');

test('/new 真正清空任务数据与资料，但保留锁定工作目录和已批准记忆', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reset-'));
  const store = createSessionStore(path.join(root, 'sessions'));
  const stateCenter = createStateCenter(path.join(root, 'state.sqlite3'));
  const referenceLibrary = createReferenceLibrary({ root: path.join(root, 'references'), chunkBytes: 4 });
  const jobs = { isActive: () => false };
  const reset = createSessionReset({ store, stateCenter, worktrees: { discard() {} }, jobs, referenceLibrary });
  const commands = createConversationCommands({ store, stateCenter, jobs, sessionReset: reset, referenceLibrary });
  try {
    const session = store.createSession({ name: '旧对话', type: 'chat', collabMode: null });
    await store.updateSession(session.id, (current) => {
      current.workspace = { path: root, boundAt: new Date().toISOString() };
      current.messages.push({ role: 'user', text: '秘密旧消息', interactionMode: 'chat' });
      return current;
    });
    const run = stateCenter.createRun({ sessionId: session.id, kind: 'chat', idempotencyKey: 'reset-test', agents: [] }).run;
    stateCenter.appendEvent(run.id, 'chat_start', { trace: '真实轨迹' });
    stateCenter.updateRun(run.id, { state: 'succeeded' });
    stateCenter.createContextNode({ scope: root, type: 'decision', title: '保留的决定', content: '长期事实', source: 'user', status: 'approved' });
    const begun = referenceLibrary.begin(session.id, {
      name: '资料', uploadKey: crypto.createHash('sha256').update('reset').digest('hex'), files: [{ path: 'a.txt', size: 4 }]
    });
    referenceLibrary.appendChunk(session.id, begun.uploadId, 0, 0, Buffer.from('data'));
    referenceLibrary.complete(session.id, begun.uploadId);

    await assert.rejects(() => commands.execute(session.id, { command: '/new' }), /再次确认/);
    const result = await commands.execute(session.id, { command: '/new', confirmed: true });
    const after = store.getSession(session.id);
    assert.equal(after.messages.length, 0);
    assert.equal(after.workspace.path, root);
    assert.equal(referenceLibrary.list(session.id).length, 0);
    assert.equal(stateCenter.listRuns({ sessionId: session.id }).length, 0);
    assert.equal(stateCenter.listContextNodes({ status: 'approved' }).some((node) => node.title === '保留的决定'), true);
    assert.equal(result.result.cleared.messages, 1);
    assert.equal(result.result.cleared.referenceUploads, 1);

    const repeated = await commands.execute(session.id, { command: '/clear', confirmed: true });
    assert.equal(repeated.result.cleared.messages, 0);
    assert.match((await commands.execute(session.id, { command: '/status' })).text, /0 条/);
    assert.match((await commands.execute(session.id, { command: '/help' })).text, /\/files/);
  } finally {
    stateCenter.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('/new 在后台运行期间拒绝清空，避免进程继续写回已删除状态', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-reset-active-'));
  const store = createSessionStore(path.join(root, 'sessions'));
  const stateCenter = createStateCenter(path.join(root, 'state.sqlite3'));
  const referenceLibrary = createReferenceLibrary({ root: path.join(root, 'references') });
  try {
    const session = store.createSession({ name: '运行中', type: 'chat', collabMode: null });
    stateCenter.createRun({ sessionId: session.id, kind: 'chat', idempotencyKey: 'active-test', agents: [] });
    const reset = createSessionReset({ store, stateCenter, worktrees: { discard() {} }, jobs: { isActive: () => false }, referenceLibrary });
    await assert.rejects(() => reset.reset(session.id), /先点击“终止”/);
    assert.equal(store.getSession(session.id).name, '运行中');
  } finally {
    stateCenter.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
