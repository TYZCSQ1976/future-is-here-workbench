const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStore } = require('../src/session-store');
const { defaultTeam } = require('../src/team');
const { importDiscussionPlan } = require('../src/plan-transfer');

test('持久化讨论方案在同一任务内进入待批准实施，并保留历史和工作目录', async () => {
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-plan-transfer-'));
  const store = createSessionStore(sessionsDir);
  try {
    const source = store.createSession({ name: '讨论', type: 'discussion', collabMode: 'cocreation' });
    await store.updateSession(source.id, (session) => {
      session.workspace = { path: '/tmp/example', boundAt: new Date().toISOString() };
      session.messages = [{ role: 'user', text: '讨论前的聊天记录', timestamp: new Date().toISOString() }];
      session.discussionPlan = {
        goal: '实现真实功能', mode: 'cocreation', plan: '# 真实方案',
        planArtifact: { artifactType: 'proposal', summary: '真实方案' },
        reviewArtifacts: [], reliability: { requiresUserDecision: false }, team: defaultTeam(),
        planHash: 'hash', promptVersion: 'test-v1', createdAt: new Date().toISOString()
      };
      return session;
    });
    const imported = await importDiscussionPlan(store, source.id, {
      contextDigest: 'c'.repeat(64),
      contextNodeIds: ['node-1'],
      deterministicVerificationPlan: { hash: 'v'.repeat(64), commands: [] }
    });
    assert.equal(imported.id, source.id);
    assert.equal(imported.type, 'collab');
    assert.equal(imported.job.state, 'waiting_approval');
    assert.equal(imported.job.plan, '# 真实方案');
    assert.equal(imported.job.contextDigest, 'c'.repeat(64));
    assert.equal(imported.job.deterministicVerificationPlan.hash, 'v'.repeat(64));
    assert.equal(imported.workspace.path, '/tmp/example');
    assert.equal(imported.messages[0].text, '讨论前的聊天记录');
    assert.equal(imported.messages.at(-1).collabRole, '已导入方案');
  } finally {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  }
});
