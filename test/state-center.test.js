const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createStateCenter } = require('../src/state-center');

function temporaryDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'future-state-center-'));
  return { directory, database: path.join(directory, 'state.sqlite3') };
}

test('状态中心对重复提交只创建一次运行，并按序保存可重放事件', () => {
  const fixture = temporaryDatabase();
  const center = createStateCenter(fixture.database);
  try {
    const first = center.createRun({
      sessionId: '1234567890', kind: 'chat', idempotencyKey: 'request-1',
      input: { message: '请一起分析' }, agents: [{ id: 'member-1', provider: 'claude', name: '甲' }]
    });
    const duplicate = center.createRun({
      sessionId: '1234567890', kind: 'chat', idempotencyKey: 'request-1',
      input: { message: '不应覆盖原输入' }, agents: []
    });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.run.id, first.run.id);
    assert.equal(duplicate.run.input.message, '请一起分析');

    const one = center.appendEvent(first.run.id, 'chat_start', { participantCount: 1 });
    const two = center.appendEvent(first.run.id, 'chat_complete', { state: 'succeeded' });
    assert.deepEqual([one.sequence, two.sequence], [1, 2]);
    assert.deepEqual(center.listEvents(first.run.id, 1).map((event) => event.type), ['chat_complete']);
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('状态中心无损压缩大型 JSON，读取和轨迹回放结果保持不变', () => {
  const fixture = temporaryDatabase();
  const center = createStateCenter(fixture.database);
  try {
    const context = '可核验上下文'.repeat(1_000);
    const payload = { message: '轨迹内容'.repeat(800), nested: { count: 3 } };
    const { run } = center.createRun({
      sessionId: '1234567890', kind: 'chat', idempotencyKey: 'compressed-json', input: { context }
    });
    center.appendEvent(run.id, 'chat_agent_trace', payload);
    assert.equal(center.getRun(run.id).input.context, context);
    assert.deepEqual(center.listEvents(run.id)[0].payload, payload);

    const result = center.compactJsonStorage();
    assert.ok(result.records >= 0);
    assert.equal(center.getRun(run.id).input.context, context);
    assert.deepEqual(center.listEvents(run.id)[0].payload, payload);
    assert.ok(center.storageStats().databaseBytes > 0);
    assert.equal(center.checkpoint({ truncate: true }).mode, 'TRUNCATE');
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('轨迹超过保留上限后明确返回截断边界，不把历史缺口伪装成完整', () => {
  const fixture = temporaryDatabase();
  const center = createStateCenter(fixture.database);
  try {
    const { run } = center.createRun({ sessionId: '1234567890', kind: 'chat', idempotencyKey: 'truncated-events', input: {} });
    for (let index = 0; index < 5_002; index += 1) center.appendEvent(run.id, 'token', { index });
    const events = center.listEvents(run.id, 0, 3);
    assert.equal(events[0].type, 'trajectory_truncated');
    assert.equal(events[0].payload.droppedFromSequence, 1);
    assert.equal(events[0].payload.droppedThroughSequence, 2);
    assert.equal(events[1].sequence, 3);
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('投递使用租约、有限重试和确认，服务重启后可重新领取未确认工作', () => {
  const fixture = temporaryDatabase();
  let center = createStateCenter(fixture.database);
  try {
    const { run } = center.createRun({ sessionId: '1234567890', kind: 'chat', idempotencyKey: 'request-2', input: {} });
    const delivery = center.enqueueDelivery({
      runId: run.id, recipientId: 'member-1', phase: 'answer', dedupeKey: 'answer:member-1',
      payload: { prompt: '回答问题' }, maxAttempts: 2
    });
    const claimed = center.claimDelivery(delivery.id, 'worker-a', 60_000);
    assert.equal(claimed.state, 'leased');
    assert.equal(claimed.attemptCount, 1);
    center.close();

    center = createStateCenter(fixture.database);
    const recovery = center.recoverInterruptedWork();
    assert.equal(recovery.recoveredDeliveries, 1);
    const reclaimed = center.claimDelivery(delivery.id, 'worker-b', 60_000);
    assert.equal(reclaimed.attemptCount, 2);
    const acknowledged = center.acknowledgeDelivery(delivery.id, { messageId: 'message-1' });
    assert.equal(acknowledged.state, 'acked');
    assert.equal(center.claimDelivery(delivery.id, 'worker-c', 60_000), null);
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('可写执行先持久化防重放栅栏，同一次运行即使重启也不能再次放行', () => {
  const fixture = temporaryDatabase();
  let center = createStateCenter(fixture.database);
  try {
    const { run } = center.createRun({
      sessionId: '1234567890',
      kind: 'execution',
      idempotencyKey: 'execution:job-1:1',
      input: { approvedJobId: 'job-1', approvedPlanHash: 'plan-hash', contextDigest: 'context-digest' },
      agents: [{ id: 'lead-1', provider: 'codex', name: '执行者' }]
    });
    center.createWorkspaceHandle({
      id: 'workspace-1', runId: run.id, sessionId: run.sessionId, agentId: 'lead-1',
      sourceRoot: '/workspace/project', isolatedPath: '/runtime/worktree', kind: 'git_worktree'
    });
    center.updateRun(run.id, { state: 'running' });
    const armed = center.armExecutionFence({
      runId: run.id, sessionId: run.sessionId, jobId: 'job-1', planHash: 'plan-hash',
      contextDigest: 'context-digest', workspaceHandleId: 'workspace-1', provider: 'codex'
    });
    assert.equal(armed.state, 'armed');
    assert.throws(() => center.armExecutionFence({
      runId: run.id, sessionId: run.sessionId, jobId: 'job-1', planHash: 'plan-hash',
      contextDigest: 'context-digest', workspaceHandleId: 'workspace-1', provider: 'codex'
    }), (error) => error.code === 'EXECUTION_REPLAY_BLOCKED');
    center.close();

    center = createStateCenter(fixture.database);
    assert.equal(center.getExecutionFence(run.id).state, 'armed');
    const settled = center.settleExecutionFence(run.id, { disposition: 'discarded', evidence: { changedCount: 0 } });
    assert.equal(settled.state, 'settled');
    assert.equal(center.settleExecutionFence(run.id, { disposition: 'discarded' }).settlement.evidence.changedCount, 0);
    assert.throws(() => center.armExecutionFence({
      runId: run.id, sessionId: run.sessionId, jobId: 'job-1', planHash: 'plan-hash',
      contextDigest: 'context-digest', workspaceHandleId: 'workspace-1', provider: 'codex'
    }), (error) => ['EXECUTION_FENCE_OWNERSHIP_CHANGED', 'EXECUTION_REPLAY_BLOCKED'].includes(error.code));
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('重启恢复阻止未结清的可写执行重放，但普通运行仍可回到队列', () => {
  const fixture = temporaryDatabase();
  const center = createStateCenter(fixture.database);
  try {
    const { run: execution } = center.createRun({
      sessionId: '1234567890', kind: 'execution', idempotencyKey: 'execution:job-2:1',
      input: { approvedJobId: 'job-2', approvedPlanHash: 'plan-hash', contextDigest: 'context-digest' },
      agents: [{ id: 'lead-1', provider: 'claude', name: '执行者' }]
    });
    center.createWorkspaceHandle({
      id: 'workspace-2', runId: execution.id, sessionId: execution.sessionId, agentId: 'lead-1',
      sourceRoot: '/workspace/project', isolatedPath: '/runtime/worktree', kind: 'git_worktree'
    });
    center.updateRun(execution.id, { state: 'running' });
    center.armExecutionFence({
      runId: execution.id, sessionId: execution.sessionId, jobId: 'job-2', planHash: 'plan-hash',
      contextDigest: 'context-digest', workspaceHandleId: 'workspace-2', provider: 'claude'
    });
    const { run: chat } = center.createRun({ sessionId: '1234567891', kind: 'chat', idempotencyKey: 'chat-1', input: {} });
    center.updateRun(chat.id, { state: 'running' });

    const recovery = center.recoverInterruptedWork();
    assert.equal(recovery.blockedExecutionRuns, 1);
    assert.equal(center.getRun(execution.id).state, 'interrupted');
    assert.equal(center.getRun(execution.id).error.code, 'EXECUTION_REPLAY_BLOCKED');
    assert.equal(center.getExecutionFence(execution.id).state, 'armed');
    assert.equal(center.getRun(chat.id).state, 'queued');
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('执行防重放栅栏拒绝空字段和与审批不一致的元数据', () => {
  const fixture = temporaryDatabase();
  const center = createStateCenter(fixture.database);
  try {
    const { run } = center.createRun({
      sessionId: '1234567890', kind: 'execution', idempotencyKey: 'execution:job-3:1',
      input: { approvedJobId: 'job-3', approvedPlanHash: 'plan-hash', contextDigest: 'context-digest' },
      agents: [{ id: 'lead-1', provider: 'codex', name: '执行者' }]
    });
    center.createWorkspaceHandle({
      id: 'workspace-3', runId: run.id, sessionId: run.sessionId, agentId: 'lead-1',
      sourceRoot: '/workspace/project', isolatedPath: '/runtime/worktree', kind: 'git_worktree'
    });
    center.updateRun(run.id, { state: 'running' });
    assert.throws(() => center.armExecutionFence({
      runId: run.id, sessionId: run.sessionId, jobId: '', planHash: 'plan-hash',
      contextDigest: 'context-digest', workspaceHandleId: 'workspace-3', provider: 'codex'
    }), (error) => error.code === 'INVALID_EXECUTION_FENCE');
    assert.throws(() => center.armExecutionFence({
      runId: run.id, sessionId: run.sessionId, jobId: 'job-3', planHash: 'wrong-plan',
      contextDigest: 'context-digest', workspaceHandleId: 'workspace-3', provider: 'codex'
    }), (error) => error.code === 'EXECUTION_FENCE_APPROVAL_CHANGED');
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('旧版状态数据库会原地升级并保留原有运行数据', () => {
  const fixture = temporaryDatabase();
  const legacy = new DatabaseSync(fixture.database);
  legacy.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE runs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, input_json TEXT NOT NULL, result_json TEXT, error_json TEXT,
      revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, UNIQUE(session_id, idempotency_key)
    );
    CREATE TABLE workspace_handles (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL, agent_id TEXT NOT NULL, source_root TEXT NOT NULL,
      isolated_path TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, base_revision TEXT,
      metadata_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL, phase TEXT NOT NULL, dedupe_key TEXT NOT NULL, state TEXT NOT NULL,
      payload_json TEXT NOT NULL, result_json TEXT, attempt_count INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      lease_owner TEXT, lease_until TEXT, last_error_json TEXT, created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, acknowledged_at TEXT, UNIQUE(run_id, dedupe_key)
    );
    INSERT INTO runs VALUES ('legacy-run', '1234567890', 'chat', 'queued', 'legacy-key', '{}', NULL, NULL, 1, '2026-01-01', '2026-01-01', NULL, NULL);
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const center = createStateCenter(fixture.database);
  try {
    assert.equal(center.getRun('legacy-run').state, 'queued');
    assert.equal(center.health().schemaVersion, 2);
    assert.equal(center.health().executionFences.armed, undefined);
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Context Tree 只向任务提供已经批准且适用的节点', () => {
  const fixture = temporaryDatabase();
  const center = createStateCenter(fixture.database);
  try {
    const proposed = center.createContextNode({
      scope: '/workspace/project', type: 'constraint', title: '不得自动部署',
      content: '所有部署必须由用户明确批准。', source: 'user', status: 'proposed'
    });
    assert.equal(center.resolveContext({ workspacePath: '/workspace/project/src', query: '部署产品' }).nodes.length, 0);
    center.decideContextNode(proposed.id, 'approved', 'user', proposed.updatedAt);
    assert.throws(() => center.decideContextNode(proposed.id, 'rejected', 'user', proposed.updatedAt), /已经被其他决定更新/);
    const resolved = center.resolveContext({ workspacePath: '/workspace/project/src', query: '部署产品' });
    assert.equal(resolved.nodes.length, 1);
    assert.equal(resolved.nodes[0].title, '不得自动部署');
    assert.match(resolved.digest, /^[a-f0-9]{64}$/);
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('Context Tree 记录版本、冲突与过期时间，替代关系由用户明确决定', () => {
  const fixture = temporaryDatabase();
  const center = createStateCenter(fixture.database);
  try {
    const original = center.createContextNode({
      scope: '/workspace/project', type: 'decision', title: '发布策略', content: '先灰度', source: 'user', status: 'approved'
    });
    const conflict = center.createContextNode({
      scope: '/workspace/project', type: 'decision', title: '发布策略', content: '直接全量', source: 'run:new'
    });
    assert.deepEqual(conflict.metadata.conflictIds, [original.id]);
    assert.throws(() => center.decideContextNode(conflict.id, 'approved', 'user', conflict.updatedAt), (error) => error.code === 'CONTEXT_CONFLICT_REQUIRES_SUPERSESSION');

    const replacement = center.createContextNode({
      scope: '/workspace/project', type: 'decision', title: '发布策略', content: '分批灰度', source: 'user', status: 'approved',
      metadata: { supersedesId: original.id, expiresAt: new Date(Date.now() + 60_000).toISOString() }
    });
    assert.equal(replacement.metadata.version, 2);
    assert.equal(center.getContextNode(original.id).status, 'superseded');
    assert.deepEqual(center.resolveContext({ workspacePath: '/workspace/project', query: '发布' }).nodes.map((node) => node.id), [replacement.id]);
    assert.throws(() => center.createContextNode({
      scope: '/workspace/project', type: 'lesson', title: '旧信息', content: '过期', source: 'user',
      metadata: { expiresAt: new Date(Date.now() - 1_000).toISOString() }
    }), (error) => error.code === 'INVALID_CONTEXT_EXPIRY');
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test('删除任务时清理运行数据和未批准临时记忆，但保留已批准团队记忆', () => {
  const fixture = temporaryDatabase();
  const center = createStateCenter(fixture.database);
  try {
    const { run } = center.createRun({ sessionId: '1234567890', kind: 'chat', idempotencyKey: 'delete-me', input: {} });
    center.recordMessage({ runId: run.id, sessionId: run.sessionId, senderId: 'member-1', phase: 'answer', text: '临时回答' });
    center.enqueueDelivery({ runId: run.id, recipientId: 'member-1', phase: 'answer', dedupeKey: 'delete-me:answer', payload: {} });
    const proposed = center.createContextNode({ scope: '/workspace/project', type: 'lesson', title: '临时经验', content: '待确认', source: `run:${run.id}`, status: 'proposed' });
    const approved = center.createContextNode({ scope: '/workspace/project', type: 'lesson', title: '已确认经验', content: '保留', source: `run:${run.id}`, status: 'proposed' });
    center.decideContextNode(approved.id, 'approved', 'user', approved.updatedAt);

    const result = center.deleteSessionData(run.sessionId);
    assert.equal(result.runs, 1);
    assert.equal(result.proposedContextNodes, 1);
    assert.equal(center.listRuns({ sessionId: run.sessionId }).length, 0);
    assert.throws(() => center.getContextNode(proposed.id), /上下文节点不存在/);
    assert.equal(center.getContextNode(approved.id).status, 'approved');
  } finally {
    center.close();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
