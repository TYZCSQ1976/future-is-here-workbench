const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionStore } = require('../src/session-store');
const { createStateCenter } = require('../src/state-center');
const { reconcileSessionJobs, statesCompatible } = require('../src/job-reconcile');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function makeSession(store, overrides = {}) {
  const session = store.createSession({ name: '对账测试', type: 'chat' });
  return store.updateSession(session.id, (current) => {
    current.job = {
      id: overrides.runId || 'test-run-id',
      kind: 'chat',
      state: overrides.jobState || 'succeeded',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    return current;
  });
}

test('启动对账能发现 job 与 run 的终态漂移', async () => {
  const store = createSessionStore(tempDir('reconcile-sessions-'));
  const stateCenter = createStateCenter(path.join(tempDir('reconcile-db-'), 'state.sqlite3'));
  try {
    const session = await makeSession(store, { jobState: 'succeeded' });
    stateCenter.createRun({ id: 'test-run-id', sessionId: session.id, kind: 'chat', idempotencyKey: 'k1', input: {} });
    stateCenter.updateRun('test-run-id', { state: 'failed' });

    const logs = [];
    const result = await reconcileSessionJobs({ store, stateCenter, log: (line) => logs.push(line) });
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].issue, 'JOB_RUN_STATE_MISMATCH');
    assert.equal(logs.length, 1);
    assert.match(logs[0], /job\.state=succeeded 与 run\.state=failed/);
  } finally {
    stateCenter.close();
  }
});

test('job 在 SQLite 中没有对应 run 时报告缺失（导入方案除外）', async () => {
  const store = createSessionStore(tempDir('reconcile-sessions-'));
  const stateCenter = createStateCenter(path.join(tempDir('reconcile-db-'), 'state.sqlite3'));
  try {
    await makeSession(store, { jobState: 'waiting_approval', runId: 'missing-run' });
    const result = await reconcileSessionJobs({ store, stateCenter, log: () => {} });
    assert.equal(result.mismatches.length, 1);
    assert.equal(result.mismatches[0].issue, 'JOB_WITHOUT_RUN');
  } finally {
    stateCenter.close();
  }
});

test('导入方案任务没有运行是合法场景，不报告漂移', async () => {
  const store = createSessionStore(tempDir('reconcile-sessions-'));
  const stateCenter = createStateCenter(path.join(tempDir('reconcile-db-'), 'state.sqlite3'));
  try {
    const session = await makeSession(store, { jobState: 'waiting_approval', runId: 'imported-run' });
    await store.updateSession(session.id, (current) => {
      current.job.kind = 'imported_plan';
      return current;
    });
    const result = await reconcileSessionJobs({ store, stateCenter, log: () => {} });
    assert.equal(result.mismatches.length, 0);
  } finally {
    stateCenter.close();
  }
});

test('重启后的活跃态互认：job=interrupted 与 run=queued 不算漂移', async () => {
  const store = createSessionStore(tempDir('reconcile-sessions-'));
  const stateCenter = createStateCenter(path.join(tempDir('reconcile-db-'), 'state.sqlite3'));
  try {
    const session = await makeSession(store, { jobState: 'interrupted' });
    stateCenter.createRun({ id: 'test-run-id', sessionId: session.id, kind: 'chat', idempotencyKey: 'k1', input: {} });
    stateCenter.updateRun('test-run-id', { state: 'queued' });
    const result = await reconcileSessionJobs({ store, stateCenter, log: () => {} });
    assert.equal(result.mismatches.length, 0);
  } finally {
    stateCenter.close();
  }
});

test('终态只按语义等价组互认，失败与成功是实质漂移', () => {
  assert.equal(statesCompatible('succeeded', 'succeeded'), true);
  assert.equal(statesCompatible('succeeded', 'partial'), true);
  assert.equal(statesCompatible('partial', 'succeeded'), true);
  assert.equal(statesCompatible('failed', 'dead_letter'), true);
  assert.equal(statesCompatible('cancelled', 'cancelled'), true);
  assert.equal(statesCompatible('succeeded', 'failed'), false);
  assert.equal(statesCompatible('partial', 'failed'), false);
  assert.equal(statesCompatible('succeeded', 'running'), false);
  assert.equal(statesCompatible('waiting_approval', 'waiting_delivery'), false);
  assert.equal(statesCompatible('queued', 'running'), true);
  assert.equal(statesCompatible('executing', 'queued'), true);
});
