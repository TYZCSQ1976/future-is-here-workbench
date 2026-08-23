const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { measureDirectory, fileBytes, removeStaleDirectories, removeStaleTempFiles } = require('./storage-budget');

function sumFiles(files) {
  return files.reduce((total, file) => total + fileBytes(file), 0);
}

function createStorageManager({
  store,
  stateCenter,
  referenceLibrary = null,
  runtimeDir = config.RUNTIME_DIR,
  sessionsDir = config.SESSIONS_DIR,
  databasePath = config.STATE_DB_PATH,
  onError = null
}) {
  let maintaining = false;
  let lastMaintenance = null;

  function usage() {
    const runtime = measureDirectory(runtimeDir);
    const sessions = measureDirectory(sessionsDir);
    const database = sumFiles([
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`
    ]);
    const references = measureDirectory(path.join(runtimeDir, 'reference-uploads')).bytes;
    const attachments = measureDirectory(path.join(runtimeDir, 'attachments')).bytes
      + measureDirectory(path.join(runtimeDir, 'folder-attachments')).bytes;
    const worktrees = measureDirectory(path.join(runtimeDir, 'worktrees')).bytes;
    const providerScratch = measureDirectory(path.join(runtimeDir, 'provider-home')).bytes;
    const logs = sumFiles([path.join(runtimeDir, 'server.log'), path.join(runtimeDir, 'server.log.1')]);
    let providerTemp = 0;
    try {
      for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('dsh-trace-')) providerTemp += measureDirectory(path.join(runtimeDir, entry.name)).bytes;
      }
    } catch (_) {}
    const knownRuntime = database + references + attachments + worktrees + providerScratch + providerTemp + logs;
    const totalBytes = runtime.bytes + sessions.bytes;
    return {
      totalBytes,
      warningBytes: config.STORAGE_WARNING_BYTES,
      warning: totalBytes >= config.STORAGE_WARNING_BYTES,
      breakdown: {
        sessions: sessions.bytes,
        database,
        references,
        attachments,
        worktrees,
        providerScratch,
        providerTemp,
        logs,
        otherRuntime: Math.max(0, runtime.bytes - knownRuntime)
      },
      files: runtime.files + sessions.files,
      lastMaintenance
    };
  }

  function maintain({ startup = false } = {}) {
    if (maintaining) return { skipped: true, reason: 'already_running', usage: usage() };
    maintaining = true;
    const before = usage();
    try {
      const sessions = store.compactStorage();
      const incompleteReferences = referenceLibrary?.cleanupIncomplete?.() || { uploads: 0, bytes: 0 };
      const providerTemp = removeStaleDirectories(runtimeDir, 'dsh-trace-', config.PROVIDER_TEMP_TTL_MS);
      const npmCache = removeStaleDirectories(runtimeDir, 'npm-cache', config.PROVIDER_TEMP_TTL_MS);
      // 只清理工作台自己拥有的目录，绝不扫描或删除用户项目里的同名文件。
      const sessionTemps = removeStaleTempFiles(sessionsDir, config.PROVIDER_TEMP_TTL_MS, Date.now(), { maxDepth: 1 });
      const runtimeTemps = removeStaleTempFiles(runtimeDir, config.PROVIDER_TEMP_TTL_MS, Date.now(), { maxDepth: 5 });
      const tempFiles = {
        files: sessionTemps.files + runtimeTemps.files,
        bytes: sessionTemps.bytes + runtimeTemps.bytes
      };
      const stateJson = stateCenter.compactJsonStorage();
      const checkpoint = stateCenter.checkpoint({ truncate: startup });
      const after = usage();
      lastMaintenance = {
        status: 'succeeded',
        at: new Date().toISOString(),
        reclaimedBytes: Math.max(0, before.totalBytes - after.totalBytes),
        compactedSessionFiles: sessions.files,
        compactedStateRecords: stateJson.records,
        logicalDatabaseSavings: stateJson.logicalSavedBytes,
        removedTempFiles: tempFiles.files,
        removedTempDirectories: providerTemp.directories + npmCache.directories,
        removedIncompleteReferences: incompleteReferences.uploads || 0,
        checkpoint
      };
      return { skipped: false, before, after: { ...after, lastMaintenance }, actions: lastMaintenance };
    } catch (error) {
      lastMaintenance = {
        status: 'failed',
        at: new Date().toISOString(),
        error: { code: error.code || 'STORAGE_MAINTENANCE_FAILED', message: String(error.message || '存储维护失败').slice(0, 300) }
      };
      throw error;
    } finally {
      maintaining = false;
    }
  }

  function start() {
    const timer = setInterval(() => {
      try { maintain({ startup: false }); }
      catch (error) { onError?.(error, lastMaintenance); }
    }, config.STORAGE_MAINTENANCE_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  return { usage, maintain, start };
}

module.exports = { createStorageManager };
