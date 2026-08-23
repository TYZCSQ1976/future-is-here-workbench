const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const { AppError } = require('./errors');

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', 'test-results']);

function realDirectory(input, field = '工作目录') {
  let candidate = String(input || '').trim();
  if (!candidate) throw new AppError(400, 'WORKSPACE_REQUIRED', `${field}不能为空`);
  if (candidate === '~') candidate = os.homedir();
  else if (candidate.startsWith('~/')) candidate = path.join(os.homedir(), candidate.slice(2));
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch (_) {
    throw new AppError(400, 'WORKSPACE_NOT_FOUND', `${field}不存在`);
  }
  if (!fs.statSync(real).isDirectory()) throw new AppError(400, 'WORKSPACE_NOT_DIRECTORY', `${field}必须是文件夹`);
  return real;
}

function isWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function allowedRoots() {
  return config.WORKSPACE_ROOTS.map((root) => {
    try { return realDirectory(root, '允许的工作区根目录'); } catch (_) { return null; }
  }).filter(Boolean);
}

function resolveWorkspace(input, currentWorkspace = null) {
  let target = String(input || '').trim();
  if (!target) throw new AppError(400, 'WORKSPACE_REQUIRED', '请输入工作目录');
  if (!path.isAbsolute(target) && !target.startsWith('~')) {
    if (!currentWorkspace) throw new AppError(400, 'WORKSPACE_ABSOLUTE_REQUIRED', '首次绑定工作区时请输入绝对路径');
    target = path.resolve(currentWorkspace, target);
  }
  const real = realDirectory(target);
  const roots = allowedRoots();
  if (!roots.some((root) => isWithin(real, root))) {
    throw new AppError(403, 'WORKSPACE_OUTSIDE_ALLOWED_ROOTS', `该目录不在允许范围内：${roots.join('、')}`);
  }
  return real;
}

function stripOptionalQuotes(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) return text.slice(1, -1);
  return text;
}

function listDirectory(workspace, requested = '.') {
  const root = realDirectory(workspace, '已绑定的工作目录');
  const raw = stripOptionalQuotes(requested) || '.';
  const candidate = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  const target = realDirectory(candidate, '要查看的目录');
  if (!isWithin(target, root)) {
    throw new AppError(403, 'WORKSPACE_PATH_ESCAPE', '只能查看当前任务已绑定工作目录内的文件');
  }
  const entries = fs.readdirSync(target, { withFileTypes: true }).slice(0, 200).map((entry) => ({
    name: entry.name,
    type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
  }));
  return { path: target, entries, truncated: fs.readdirSync(target).length > entries.length };
}

function runWorkspaceCommand(command, currentWorkspace = null) {
  const text = String(command || '').trim();
  if (text === 'pwd') {
    if (!currentWorkspace) throw new AppError(409, 'WORKSPACE_NOT_BOUND', '当前任务还没有绑定工作目录');
    return { command: 'pwd', workspacePath: currentWorkspace, output: currentWorkspace };
  }
  const cd = text.match(/^cd(?:\s+(.+))?$/s);
  if (cd) {
    if (currentWorkspace) throw new AppError(409, 'WORKSPACE_LOCKED', '这个任务的工作目录已经锁定，不能在对话中更换');
    const workspacePath = resolveWorkspace(stripOptionalQuotes(cd[1] || ''), null);
    return { command: 'cd', workspacePath, output: `当前工作目录：${workspacePath}` };
  }
  const ls = text.match(/^ls(?:\s+(.+))?$/s);
  if (ls) {
    if (!currentWorkspace) throw new AppError(409, 'WORKSPACE_NOT_BOUND', '请先使用 cd 绑定工作目录');
    const result = listDirectory(currentWorkspace, ls[1] || '.');
    const output = result.entries.map((entry) => `${entry.type === 'directory' ? '📁' : '📄'} ${entry.name}`).join('\n');
    return { command: 'ls', workspacePath: currentWorkspace, output: output || '（空文件夹）', listing: result };
  }
  throw new AppError(400, 'UNSUPPORTED_WORKSPACE_COMMAND', '这里只支持 pwd、cd <目录> 和 ls [目录]；不会执行任意 shell 命令');
}

function snapshotWorkspace(workspace) {
  const root = resolveWorkspace(workspace, workspace);
  const manifest = {};
  let fileCount = 0;
  let entryCount = 0;
  const startedAt = Date.now();
  const stack = [{ current: root, relativeBase: '', depth: 0 }];
  while (stack.length) {
    if (Date.now() - startedAt > config.WORKSPACE_SNAPSHOT_TIMEOUT_MS) {
      throw new AppError(413, 'WORKSPACE_SNAPSHOT_LIMIT', '工作区太复杂，快照超过时间上限');
    }
    const { current, relativeBase, depth } = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      entryCount += 1;
      if (entryCount > config.MAX_WORKSPACE_ENTRIES) {
        throw new AppError(413, 'WORKSPACE_SNAPSHOT_LIMIT', '工作区目录项过多，已停止快照');
      }
      if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue;
      const relative = path.join(relativeBase, entry.name);
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 > config.MAX_WORKSPACE_DEPTH) {
          throw new AppError(413, 'WORKSPACE_SNAPSHOT_LIMIT', '工作区目录层级过深，已停止快照');
        }
        stack.push({ current: full, relativeBase: relative, depth: depth + 1 });
      }
      else if (entry.isFile()) {
        fileCount += 1;
        if (fileCount > config.MAX_WORKSPACE_FILES) {
          throw new AppError(413, 'WORKSPACE_SNAPSHOT_LIMIT', '工作区文件过多，已停止快照');
        }
        const stat = fs.statSync(full);
        manifest[relative] = `${stat.size}:${stat.mtimeMs}`;
      }
    }
  }
  return { root, manifest, truncated: false, fileCount, entryCount };
}

function diffSnapshots(before, after) {
  const changedFiles = [];
  const all = new Set([...Object.keys(before.manifest), ...Object.keys(after.manifest)]);
  for (const file of all) {
    if (!(file in before.manifest)) changedFiles.push({ path: file, change: 'added' });
    else if (!(file in after.manifest)) changedFiles.push({ path: file, change: 'deleted' });
    else if (before.manifest[file] !== after.manifest[file]) changedFiles.push({ path: file, change: 'modified' });
  }
  return { changedFiles: changedFiles.slice(0, 500), changedCount: changedFiles.length, truncated: changedFiles.length > 500 };
}

module.exports = { allowedRoots, resolveWorkspace, listDirectory, runWorkspaceCommand, snapshotWorkspace, diffSnapshots, isWithin };
