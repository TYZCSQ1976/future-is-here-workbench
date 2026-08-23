const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

function measureDirectory(root, options = {}) {
  const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : Infinity;
  const maxEntries = Number.isFinite(options.maxEntries) ? options.maxEntries : 100_000;
  if (!root || !fs.existsSync(root)) return { bytes: 0, files: 0, directories: 0, exceeded: false };
  const stack = [root];
  let bytes = 0;
  let files = 0;
  let directories = 0;
  let entries = 0;
  while (stack.length) {
    const current = stack.pop();
    let children = [];
    try { children = fs.readdirSync(current, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of children) {
      entries += 1;
      if (entries > maxEntries) return { bytes, files, directories, exceeded: true };
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { directories += 1; stack.push(full); }
      else if (entry.isFile()) {
        try { bytes += fs.statSync(full).size; files += 1; } catch (_) {}
        if (bytes > maxBytes) return { bytes, files, directories, exceeded: true };
      }
    }
  }
  return { bytes, files, directories, exceeded: false };
}

function fileBytes(file) {
  try { return fs.statSync(file).isFile() ? fs.statSync(file).size : 0; } catch (_) { return 0; }
}

function runtimeUsage() {
  const runtime = measureDirectory(config.RUNTIME_DIR);
  const sessions = measureDirectory(config.SESSIONS_DIR);
  return { runtimeBytes: runtime.bytes, sessionBytes: sessions.bytes, totalBytes: runtime.bytes + sessions.bytes };
}

function storagePressure(addedBytes = 0) {
  const growth = Math.max(0, Number(addedBytes) || 0);
  const usage = runtimeUsage();
  const projectedBytes = usage.totalBytes + growth;
  return {
    ...usage,
    projectedBytes,
    warningBytes: config.STORAGE_WARNING_BYTES,
    warning: projectedBytes >= config.STORAGE_WARNING_BYTES
  };
}

function removeStaleDirectories(root, prefix, olderThanMs, now = Date.now()) {
  if (!fs.existsSync(root)) return { directories: 0, bytes: 0 };
  let directories = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const target = path.join(root, entry.name);
    let modifiedAt = 0;
    try { modifiedAt = fs.statSync(target).mtimeMs; } catch (_) { continue; }
    if (now - modifiedAt < olderThanMs) continue;
    const usage = measureDirectory(target);
    fs.rmSync(target, { recursive: true, force: true });
    directories += 1;
    bytes += usage.bytes;
  }
  return { directories, bytes };
}

function removeStaleTempFiles(root, olderThanMs, now = Date.now(), options = {}) {
  if (!fs.existsSync(root)) return { files: 0, bytes: 0 };
  const maxDepth = Number.isInteger(options.maxDepth) ? Math.max(0, options.maxDepth) : 4;
  let files = 0;
  let bytes = 0;
  const stack = [{ directory: root, depth: 0 }];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ directory: target, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
      let stat;
      try { stat = fs.statSync(target); } catch (_) { continue; }
      if (now - stat.mtimeMs < olderThanMs) continue;
      try {
        fs.unlinkSync(target);
        files += 1;
        bytes += stat.size;
      } catch (_) {}
    }
  }
  return { files, bytes };
}

module.exports = {
  measureDirectory,
  fileBytes,
  runtimeUsage,
  storagePressure,
  removeStaleDirectories,
  removeStaleTempFiles
};
