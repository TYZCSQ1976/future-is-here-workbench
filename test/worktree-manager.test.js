const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const config = require('../src/config');
const { createStateCenter } = require('../src/state-center');
const { createWorktreeManager } = require('../src/worktree-manager');

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

test('可写成员只修改独立 Git worktree，用户批准后才交付且不复制 node_modules', () => {
  const repository = fs.mkdtempSync(path.join(config.PROJECT_ROOT, '.worktree-manager-test-'));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'future-worktrees-'));
  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-worktree-db-'));
  const center = createStateCenter(path.join(databaseDir, 'state.sqlite3'));
  try {
    git(repository, 'init');
    git(repository, 'config', 'user.email', 'test@example.com');
    git(repository, 'config', 'user.name', 'Test User');
    fs.writeFileSync(path.join(repository, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(repository, 'app.js'), 'module.exports = "before";\n');
    fs.mkdirSync(path.join(repository, 'node_modules'));
    fs.writeFileSync(path.join(repository, 'node_modules', 'large.bin'), '不应复制');
    git(repository, 'add', '.gitignore', 'app.js');
    git(repository, 'commit', '-m', 'initial');

    const { run } = center.createRun({ sessionId: '1234567890', kind: 'execution', idempotencyKey: 'execution-1', input: {} });
    const manager = createWorktreeManager({ stateCenter: center, runtimeRoot: runtime });
    const handle = manager.prepare({ runId: run.id, sessionId: run.sessionId, agentId: 'member-1', workspacePath: repository });
    assert.equal(fs.existsSync(path.join(handle.isolatedPath, 'node_modules')), false);

    fs.writeFileSync(path.join(handle.isolatedPath, 'app.js'), 'module.exports = "after";\n');
    fs.writeFileSync(path.join(handle.isolatedPath, 'new.js'), 'module.exports = true;\n');
    assert.match(fs.readFileSync(path.join(repository, 'app.js'), 'utf8'), /before/);
    assert.equal(fs.existsSync(path.join(repository, 'new.js')), false);

    const inspected = manager.inspect(handle.id);
    assert.equal(inspected.evidence.changedCount, 2);
    assert.equal(inspected.handle.state, 'awaiting_delivery');
    fs.writeFileSync(path.join(handle.isolatedPath, 'app.js'), 'module.exports = "reviewed-after-but-later-replaced";\n');
    assert.throws(
      () => manager.deliver(handle.id, { patchHash: inspected.evidence.patchHash, baseRevision: handle.baseRevision }),
      /审核后发生了变化/
    );
    fs.writeFileSync(path.join(handle.isolatedPath, 'app.js'), 'module.exports = "after";\n');
    const delivered = manager.deliver(handle.id, { patchHash: inspected.evidence.patchHash, baseRevision: handle.baseRevision });
    assert.equal(delivered.state, 'delivered');
    assert.match(fs.readFileSync(path.join(repository, 'app.js'), 'utf8'), /after/);
    assert.equal(fs.readFileSync(path.join(repository, 'new.js'), 'utf8'), 'module.exports = true;\n');
    assert.equal(fs.existsSync(handle.isolatedPath), false);
  } finally {
    center.close();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.rmSync(databaseDir, { recursive: true, force: true });
  }
});

test('控制面登记失败时回收刚创建的孤儿 worktree', () => {
  const repository = fs.mkdtempSync(path.join(config.PROJECT_ROOT, '.worktree-rollback-test-'));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'future-worktree-rollback-'));
  try {
    git(repository, 'init');
    git(repository, 'config', 'user.email', 'test@example.com');
    git(repository, 'config', 'user.name', 'Test User');
    fs.writeFileSync(path.join(repository, 'app.js'), 'module.exports = true;\n');
    git(repository, 'add', 'app.js');
    git(repository, 'commit', '-m', 'initial');

    const manager = createWorktreeManager({
      runtimeRoot: runtime,
      stateCenter: {
        listWorkspaceHandles() { return []; },
        createWorkspaceHandle() { throw new Error('模拟数据库登记失败'); }
      }
    });
    assert.throws(() => manager.prepare({
      runId: 'rollback-run',
      sessionId: '1234567890',
      agentId: 'member-1',
      workspacePath: repository
    }), /模拟数据库登记失败/);
    assert.equal(fs.existsSync(path.join(runtime, 'rollback-run', 'member-1')), false);
    assert.doesNotMatch(git(repository, 'worktree', 'list', '--porcelain'), /rollback-run/);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});

test('重启时能辨认补丁已经应用但状态未登记的交付', () => {
  const repository = fs.mkdtempSync(path.join(config.PROJECT_ROOT, '.worktree-reconcile-test-'));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'future-worktree-reconcile-'));
  const databaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'future-worktree-reconcile-db-'));
  const center = createStateCenter(path.join(databaseDir, 'state.sqlite3'));
  try {
    git(repository, 'init');
    git(repository, 'config', 'user.email', 'test@example.com');
    git(repository, 'config', 'user.name', 'Test User');
    fs.writeFileSync(path.join(repository, 'app.js'), 'before\n');
    git(repository, 'add', 'app.js');
    git(repository, 'commit', '-m', 'initial');
    const { run } = center.createRun({ sessionId: '1234567890', kind: 'execution', idempotencyKey: 'reconcile', input: {} });
    const manager = createWorktreeManager({
      stateCenter: center,
      runtimeRoot: runtime,
      afterPatchApplied() { throw new Error('模拟断电'); }
    });
    const handle = manager.prepare({ runId: run.id, sessionId: run.sessionId, agentId: 'member-1', workspacePath: repository });
    fs.writeFileSync(path.join(handle.isolatedPath, 'app.js'), 'after\n');
    const inspected = manager.inspect(handle.id);
    assert.throws(() => manager.deliver(handle.id, {
      patchHash: inspected.evidence.patchHash,
      baseRevision: handle.baseRevision
    }), /模拟断电/);
    assert.equal(center.getWorkspaceHandle(handle.id).state, 'delivering');

    const recovery = createWorktreeManager({ stateCenter: center, runtimeRoot: runtime }).reconcileDeliveries();
    assert.equal(recovery[0].disposition, 'delivered', JSON.stringify(recovery[0]));
    assert.equal(center.getWorkspaceHandle(handle.id).state, 'delivered');
    assert.equal(fs.readFileSync(path.join(repository, 'app.js'), 'utf8'), 'after\n');
  } finally {
    center.close();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
    fs.rmSync(databaseDir, { recursive: true, force: true });
  }
});
