const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStateCenter } = require('../src/state-center');
const { createBackupManager, applyPendingRestore } = require('../src/backup-manager');

test('恢复快照使用硬链接节省资料空间，并在下次启动前恢复数据库与会话', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'future-backup-'));
  const runtime = path.join(root, '.workbench');
  const sessions = path.join(root, 'sessions');
  const backups = path.join(runtime, 'backups');
  const database = path.join(runtime, 'state.sqlite3');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(runtime, 'reference-uploads', '1234567890'), { recursive: true });
  fs.writeFileSync(path.join(sessions, '1234567890.json'), '{"value":"before"}');
  const reference = path.join(runtime, 'reference-uploads', '1234567890', 'large.bin');
  fs.writeFileSync(reference, 'immutable-reference');
  let center = createStateCenter(database);
  try {
    center.createRun({ sessionId: '1234567890', kind: 'chat', idempotencyKey: 'before', input: { value: 'before' } });
    const manager = createBackupManager({ stateCenter: center, root: backups, sessionsDir: sessions, runtimeDir: runtime });
    const snapshot = manager.create();
    assert.equal(manager.list().length, 1);
    const linked = path.join(backups, snapshot.id, 'reference-uploads', '1234567890', 'large.bin');
    assert.equal(fs.statSync(reference).ino, fs.statSync(linked).ino);
    fs.writeFileSync(path.join(sessions, '1234567890.json'), '{"value":"after"}');
    manager.requestRestore(snapshot.id);
    center.close();
    center = null;

    const restored = applyPendingRestore({ root: backups, sessionsDir: sessions, runtimeDir: runtime, databasePath: database });
    assert.equal(restored.id, snapshot.id);
    assert.equal(fs.readFileSync(path.join(sessions, '1234567890.json'), 'utf8'), '{"value":"before"}');
    center = createStateCenter(database);
    assert.equal(center.findRunByRequest('1234567890', 'before').input.value, 'before');
  } finally {
    center?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
