const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('./config');
const { AppError } = require('./errors');

const SNAPSHOT_PATTERN = /^snapshot-\d{8}T\d{6}-[0-9a-f]{8}$/;

function snapshotId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');
  return `snapshot-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function copyTreeWithLinks(source, destination, { linkFiles = true } = {}) {
  if (!fs.existsSync(source)) return { files: 0, linkedFiles: 0, copiedBytes: 0 };
  const totals = { files: 0, linkedFiles: 0, copiedBytes: 0 };
  const visit = (from, to) => {
    const stats = fs.lstatSync(from);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      fs.mkdirSync(to, { recursive: true, mode: 0o700 });
      for (const name of fs.readdirSync(from)) visit(path.join(from, name), path.join(to, name));
      return;
    }
    if (!stats.isFile() || /\.tmp$/.test(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    if (linkFiles) {
      try { fs.linkSync(from, to); totals.linkedFiles += 1; }
      catch (_) { fs.copyFileSync(from, to); totals.copiedBytes += stats.size; }
    } else {
      fs.copyFileSync(from, to);
      totals.copiedBytes += stats.size;
    }
    if (process.platform !== 'win32') fs.chmodSync(to, 0o600);
    totals.files += 1;
  };
  visit(source, destination);
  return totals;
}

function hashFileBounded(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead);
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function inventoryTree(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile() && entry.name !== 'manifest.json') {
        const stats = fs.statSync(target);
        files.push({ path: path.relative(root, target).split(path.sep).join('/'), bytes: stats.size, sha256: hashFileBounded(target) });
      }
    }
  };
  visit(root);
  return files;
}

function listSnapshots(root = config.BACKUP_ROOT) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && SNAPSHOT_PATTERN.test(entry.name))
    .map((entry) => {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'manifest.json'), 'utf8'));
        return { id: entry.name, ...manifest };
      } catch (_) { return null; }
    })
    .filter(Boolean)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function createBackupManager({
  stateCenter,
  hasActiveWork = () => false,
  root = config.BACKUP_ROOT,
  sessionsDir = config.SESSIONS_DIR,
  runtimeDir = config.RUNTIME_DIR
} = {}) {
  let creating = false;

  function create() {
    if (creating) throw new AppError(409, 'BACKUP_IN_PROGRESS', '已经有一份恢复快照正在创建');
    if (hasActiveWork()) throw new AppError(409, 'BACKUP_ACTIVE_WORK', '存在运行中任务、资料解析或未处理的隔离产物，请完成后再备份');
    creating = true;
    const id = snapshotId();
    const temporary = path.join(root, `.${id}.tmp`);
    const destination = path.join(root, id);
    try {
      fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
      const database = stateCenter.backupTo(path.join(temporary, 'state.sqlite3'));
      // 会话文件仍可能变化，必须复制；上传资料与附件完成后不可变，才能安全使用硬链接。
      const sessions = copyTreeWithLinks(sessionsDir, path.join(temporary, 'sessions'), { linkFiles: false });
      const references = copyTreeWithLinks(path.join(runtimeDir, 'reference-uploads'), path.join(temporary, 'reference-uploads'));
      const attachments = copyTreeWithLinks(path.join(runtimeDir, 'attachments'), path.join(temporary, 'attachments'));
      const folders = copyTreeWithLinks(path.join(runtimeDir, 'folder-attachments'), path.join(temporary, 'folder-attachments'));
      const inventory = inventoryTree(temporary);
      const manifest = {
        version: 1,
        createdAt: new Date().toISOString(),
        databaseBytes: database.bytes,
        files: sessions.files + references.files + attachments.files + folders.files + 1,
        linkedFiles: sessions.linkedFiles + references.linkedFiles + attachments.linkedFiles + folders.linkedFiles,
        copiedBytes: database.bytes + sessions.copiedBytes + references.copiedBytes + attachments.copiedBytes + folders.copiedBytes,
        inventory,
        inventoryDigest: crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
        includes: ['state.sqlite3', 'sessions', 'reference-uploads', 'attachments', 'folder-attachments'],
        excludes: ['provider临时文件', '日志', 'node_modules', '已完成或未完成的Git worktree']
      };
      fs.writeFileSync(path.join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      fs.renameSync(temporary, destination);
      for (const stale of listSnapshots(root).slice(config.MAX_BACKUPS)) {
        fs.rmSync(path.join(root, stale.id), { recursive: true, force: true });
      }
      return { id, ...manifest };
    } catch (error) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (_) {}
      throw error;
    } finally {
      creating = false;
    }
  }

  function requestRestore(id) {
    if (!SNAPSHOT_PATTERN.test(String(id || ''))) throw new AppError(400, 'INVALID_BACKUP_ID', '恢复快照编号无效');
    const snapshot = path.join(root, id);
    if (!fs.existsSync(path.join(snapshot, 'manifest.json'))) throw new AppError(404, 'BACKUP_NOT_FOUND', '恢复快照不存在');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(root, 'restore-request.json'), JSON.stringify({ id, requestedAt: new Date().toISOString() }), { mode: 0o600 });
    return { id, restartRequired: true };
  }

  return { create, list: () => listSnapshots(root), requestRestore };
}

function applyPendingRestore({
  root = config.BACKUP_ROOT,
  sessionsDir = config.SESSIONS_DIR,
  runtimeDir = config.RUNTIME_DIR,
  databasePath = config.STATE_DB_PATH
} = {}) {
  const requestPath = path.join(root, 'restore-request.json');
  if (!fs.existsSync(requestPath)) return null;
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  if (!SNAPSHOT_PATTERN.test(String(request.id || ''))) throw new Error('恢复请求中的快照编号无效');
  const snapshot = path.join(root, request.id);
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || !fs.existsSync(path.join(snapshot, 'state.sqlite3'))) throw new Error('恢复快照不完整');
  if (!Array.isArray(manifest.inventory)
    || crypto.createHash('sha256').update(JSON.stringify(manifest.inventory)).digest('hex') !== manifest.inventoryDigest) {
    throw new Error('恢复快照清单已损坏');
  }
  for (const item of manifest.inventory) {
    if (!item || typeof item.path !== 'string' || item.path.split('/').includes('..')) throw new Error('恢复快照包含无效路径');
    const file = path.join(snapshot, item.path);
    if (!fs.existsSync(file) || fs.statSync(file).size !== item.bytes || hashFileBounded(file) !== item.sha256) {
      throw new Error(`恢复快照校验失败：${item.path}`);
    }
  }

  const restoreOne = (source, target) => {
    const staging = `${target}.restore-stage`;
    const previous = `${target}.restore-previous`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(previous, { recursive: true, force: true });
    if (fs.existsSync(source)) fs.cpSync(source, staging, { recursive: true, force: false, errorOnExist: true });
    else fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) fs.renameSync(target, previous);
    try { fs.renameSync(staging, target); }
    catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, target);
      throw error;
    }
    fs.rmSync(previous, { recursive: true, force: true });
  };

  restoreOne(path.join(snapshot, 'sessions'), sessionsDir);
  restoreOne(path.join(snapshot, 'reference-uploads'), path.join(runtimeDir, 'reference-uploads'));
  restoreOne(path.join(snapshot, 'attachments'), path.join(runtimeDir, 'attachments'));
  restoreOne(path.join(snapshot, 'folder-attachments'), path.join(runtimeDir, 'folder-attachments'));
  const databaseStaging = `${databasePath}.restore-stage`;
  fs.copyFileSync(path.join(snapshot, 'state.sqlite3'), databaseStaging);
  fs.renameSync(databaseStaging, databasePath);
  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
  fs.rmSync(requestPath, { force: true });
  return { id: request.id, restoredAt: new Date().toISOString() };
}

module.exports = { createBackupManager, applyPendingRestore, listSnapshots, copyTreeWithLinks };
