const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionStore } = require('../src/session-store');

test('会话存储能串行化并发写入，并使用私有文件权限', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-workbench-'));
  try {
    const store = createSessionStore(tempDir);
    const session = store.createSession({ name: '测试任务', type: 'chat', collabMode: null });

    await Promise.all(Array.from({ length: 20 }, (_, index) => store.appendMessage(session.id, {
      role: 'user',
      text: `消息 ${index}`,
      timestamp: new Date().toISOString()
    })));

    const saved = store.getSession(session.id);
    assert.equal(saved.messages.length, 20);
    assert.equal(new Set(saved.messages.map((message) => message.text)).size, 20);
    assert.equal(fs.statSync(tempDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(tempDir, `${session.id}.json`)).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('工作流检查点和可靠性状态会持久化并出现在任务列表', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-workbench-'));
  try {
    const store = createSessionStore(tempDir);
    const session = store.createSession({ name: '长程任务', type: 'collab', collabMode: 'cocreation' });
    await store.recordWorkflowCheckpoint(session.id, {
      phase: 'consensus_reached',
      round: 2,
      objective: '完成一个长期任务',
      mode: 'cocreation',
      promptVersion: 'test-v1',
      reliability: { approved: true },
      acceptedPlan: { artifactType: 'proposal', summary: '已批准方案' },
      summary: '独立审查通过'
    });
    const saved = store.getSession(session.id);
    assert.equal(saved.workflow.phase, 'consensus_reached');
    assert.equal(saved.workflow.checkpoints.length, 1);
    assert.equal(saved.workflow.acceptedPlan.summary, '已批准方案');
    const listed = await store.listSessions();
    assert.equal(listed[0].workflowPhase, 'consensus_reached');
    assert.equal(listed[0].reliability.approved, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('归档任务不会继续出现在列表中', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-workbench-'));
  try {
    const store = createSessionStore(tempDir);
    const session = store.createSession({ name: '待归档', type: 'chat', collabMode: null });
    await store.archiveSession(session.id);
    const sessions = await store.listSessions();
    assert.equal(sessions.some((item) => item.id === session.id), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('永久删除只删除指定任务文件，并让任务不可再读取', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-workbench-'));
  try {
    const store = createSessionStore(tempDir);
    const keep = store.createSession({ name: '保留任务', type: 'chat', collabMode: null });
    const remove = store.createSession({ name: '删除任务', type: 'chat', collabMode: null });
    await store.deleteSession(remove.id);
    assert.equal(fs.existsSync(path.join(tempDir, `${remove.id}.json`)), false);
    assert.equal(store.getSession(keep.id).name, '保留任务');
    assert.throws(() => store.getSession(remove.id), /任务不存在/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
