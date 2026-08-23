const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listSessionTracePage,
  normalizeTraceEvent,
  redactSecrets,
  safeJsonValue
} = require('../src/agent-trace');
const { createStateCenter } = require('../src/state-center');

test('轨迹契约会脱敏、限制体积，并保留可核验的结构化字段', () => {
  const normalized = normalizeTraceEvent({
    invocationId: 'invoke-1',
    actionId: 'action-1',
    kind: 'command',
    status: 'failed',
    title: '执行测试',
    summary: `API_KEY=sk-1234567890123456 ${'很长'.repeat(500)}`,
    input: { command: 'curl -H "Authorization: Bearer abc.def.ghi" https://example.test' },
    output: { preview: 'PASSWORD=hunter2\u0000\u0007' },
    metrics: { durationMs: 123, exitCode: 1 },
    error: { code: 'EXIT_1', message: 'TOKEN=my-private-token' },
    source: 'test',
    visibility: 'full',
    eventAt: '2026-08-15T00:00:00.000Z'
  });

  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.kind, 'command');
  assert.equal(normalized.status, 'failed');
  assert.equal(normalized.actionId, 'action-1');
  assert.equal(normalized.eventAt, '2026-08-15T00:00:00.000Z');
  assert.equal(normalized.summaryTruncated, true);
  assert.ok(normalized.summary.length <= 800);
  assert.doesNotMatch(JSON.stringify(normalized), /sk-1234567890123456|abc\.def\.ghi|hunter2|my-private-token/);
  assert.match(JSON.stringify(normalized), /已隐藏|令牌已隐藏/);
  assert.deepEqual(normalized.metrics, { durationMs: 123, exitCode: 1 });
});

test('轨迹脱敏与 JSON 边界对异常数据同样生效', () => {
  assert.equal(redactSecrets('Bearer top.secret.token'), 'Bearer [已隐藏]');
  const safe = safeJsonValue({
    list: Array.from({ length: 25 }, (_, index) => index),
    deep: { one: { two: { three: { secret: '不应继续展开' } } } }
  });
  assert.equal(safe.list.length, 20);
  assert.equal(safe.deep.one.two, '[已省略]');
});

test('轨迹历史以运行分页，刷新后仍按原始序号准确回放', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'future-agent-trace-'));
  const center = createStateCenter(path.join(root, 'state.sqlite3'));
  try {
    for (let index = 1; index <= 3; index += 1) {
      const run = center.createRun({
        id: `run-${index}`,
        sessionId: 'session-1',
        kind: index === 3 ? 'collaboration' : 'chat',
        idempotencyKey: `request-${index}`,
        input: {}
      }).run;
      center.updateRun(run.id, { state: 'running' });
      center.appendEvent(run.id, 'unrelated_event', { ignored: true });
      center.appendEvent(run.id, 'chat_agent_trace', normalizeTraceEvent({
        invocationId: `invoke-${index}`,
        kind: 'command',
        status: 'succeeded',
        title: `命令 ${index}`,
        summary: `第 ${index} 次`,
        source: 'test'
      }));
      center.appendEvent(run.id, 'chat_agent_trace', normalizeTraceEvent({
        invocationId: `invoke-${index}`,
        kind: 'usage', status: 'info', title: '用量', summary: '',
        metrics: { usage: { inputTokens: index * 10, outputTokens: index * 2 } },
        source: 'test'
      }));
      center.updateRun(run.id, { state: 'succeeded' });
    }

    const newest = listSessionTracePage(center, 'session-1', { limit: 2 });
    assert.deepEqual(newest.runs.map((run) => run.id), ['run-2', 'run-3']);
    assert.equal(newest.traces.length, 4);
    assert.deepEqual(newest.traces.map((trace) => trace.sequence), [2, 3, 2, 3]);
    assert.equal(newest.page.hasMore, true);
    assert.equal(newest.page.beforeRunId, 'run-2');
    assert.equal(newest.runs[1].state, 'succeeded');
    assert.deepEqual(newest.tokenUsage, { inputTokens: 50, outputTokens: 10, totalTokens: 60 });

    const older = listSessionTracePage(center, 'session-1', { limit: 2, beforeRunId: newest.page.beforeRunId });
    assert.deepEqual(older.runs.map((run) => run.id), ['run-1']);
    assert.equal(older.page.hasMore, false);
    assert.equal(older.traces[0].title, '命令 1');
  } finally {
    center.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
