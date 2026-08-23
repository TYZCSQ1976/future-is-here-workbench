const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionStore } = require('../src/session-store');
const { createStateCenter } = require('../src/state-center');
const { createStorageManager } = require('../src/storage-manager');
const { createLogger } = require('../src/logger');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'future-storage-'));
}

test('会话维护只去掉 JSON 排版空白，消息、版本和时间完全不变', () => {
  const root = tempRoot();
  try {
    const sessions = path.join(root, 'sessions');
    const store = createSessionStore(sessions);
    const created = store.createSession({ name: '无损压缩', type: 'chat', collabMode: null });
    const file = path.join(sessions, `${created.id}.json`);
    const originalData = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify(originalData, null, 2), { mode: 0o600 });
    const beforeBytes = fs.statSync(file).size;

    const result = store.compactStorage();
    const afterData = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(afterData, originalData);
    assert.ok(fs.statSync(file).size < beforeBytes);
    assert.equal(result.files, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('诊断日志只保留两份有界文件，不记录到无限增长的重定向文件', () => {
  const root = tempRoot();
  try {
    const file = path.join(root, 'server.log');
    const logger = createLogger({ file, maxBytes: 1_024, mirror: false });
    for (let index = 0; index < 100; index += 1) logger.info('capacity_test', { index, note: 'x'.repeat(60) });
    assert.ok(fs.statSync(file).size <= 1_024);
    assert.ok(fs.statSync(`${file}.1`).size <= 1_024);
    assert.ok(fs.statSync(file).size + fs.statSync(`${file}.1`).size <= 2_048);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('自动维护只清理工作台拥有的过期临时文件，并保留完整会话与轨迹', () => {
  const root = tempRoot();
  const runtime = path.join(root, '.workbench');
  const sessions = path.join(root, 'sessions');
  const database = path.join(runtime, 'state.sqlite3');
  fs.mkdirSync(runtime, { recursive: true });
  const store = createSessionStore(sessions);
  const session = store.createSession({ name: '容量测试', type: 'chat', collabMode: null });
  const center = createStateCenter(database);
  try {
    const { run } = center.createRun({ sessionId: session.id, kind: 'chat', idempotencyKey: 'storage-run', input: { message: '必须保留' } });
    center.appendEvent(run.id, 'chat_agent_trace', { message: '真实轨迹' });
    center.updateRun(run.id, { state: 'succeeded', result: { text: '完整回答' } });

    const staleDirectory = path.join(runtime, 'dsh-trace-crashed');
    fs.mkdirSync(staleDirectory);
    fs.writeFileSync(path.join(staleDirectory, 'events.jsonl'), 'temporary');
    const staleTemp = path.join(sessions, 'atomic-write.tmp');
    fs.writeFileSync(staleTemp, 'temporary');
    const userTemp = path.join(root, '用户资料.tmp');
    fs.writeFileSync(userTemp, '必须保留');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(staleDirectory, old, old);
    fs.utimesSync(staleTemp, old, old);
    fs.utimesSync(userTemp, old, old);

    const manager = createStorageManager({ store, stateCenter: center, runtimeDir: runtime, sessionsDir: sessions, databasePath: database });
    const result = manager.maintain({ startup: true });
    assert.equal(fs.existsSync(staleDirectory), false);
    assert.equal(fs.existsSync(staleTemp), false);
    assert.equal(fs.existsSync(userTemp), true);
    assert.equal(store.getSession(session.id).name, '容量测试');
    assert.equal(center.getRun(run.id).input.message, '必须保留');
    assert.equal(center.listEvents(run.id)[0].payload.message, '真实轨迹');
    assert.ok(result.after.totalBytes >= 0);
  } finally {
    center.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
