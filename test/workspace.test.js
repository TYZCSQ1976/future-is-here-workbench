const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { resolveWorkspace, runWorkspaceCommand, snapshotWorkspace, diffSnapshots } = require('../src/workspace');

test('工作区命令只实现 cd、pwd、ls，不把输入交给 shell', () => {
  const workspace = resolveWorkspace(config.PROJECT_ROOT);
  assert.equal(runWorkspaceCommand(`cd ${workspace}`).workspacePath, workspace);
  assert.equal(runWorkspaceCommand('pwd', workspace).output, workspace);
  assert.throws(() => runWorkspaceCommand('cd src', workspace), /已经锁定/);
  assert.equal(runWorkspaceCommand('ls src', workspace).listing.entries.some((entry) => entry.name === 'workspace.js'), true);
  assert.throws(() => runWorkspaceCommand('ls ..', workspace), /只能查看/);
  assert.throws(() => runWorkspaceCommand('echo hello', workspace), /只支持 pwd、cd/);
  assert.throws(() => runWorkspaceCommand('cd /', null), /不在允许范围/);
});

test('执行前后快照能给出真实文件变化证据', () => {
  const temp = fs.mkdtempSync(path.join(config.PROJECT_ROOT, '.workspace-test-'));
  try {
    const before = snapshotWorkspace(temp);
    fs.writeFileSync(path.join(temp, 'result.txt'), '真实产物');
    const after = snapshotWorkspace(temp);
    const diff = diffSnapshots(before, after);
    assert.equal(diff.changedCount, 1);
    assert.deepEqual(diff.changedFiles[0], { path: 'result.txt', change: 'added' });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
