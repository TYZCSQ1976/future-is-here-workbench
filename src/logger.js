const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

function createLogger(options = {}) {
  const file = options.file || path.join(config.RUNTIME_DIR, 'server.log');
  const backup = `${file}.1`;
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1_024, options.maxBytes) : config.MAX_SERVER_LOG_BYTES;

  function ensureDirectory() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }

  function rotate(incomingBytes) {
    let currentBytes = 0;
    try { currentBytes = fs.statSync(file).size; } catch (_) {}
    if (currentBytes + incomingBytes <= maxBytes) return;
    try { fs.rmSync(backup, { force: true }); } catch (_) {}
    try { fs.renameSync(file, backup); } catch (_) {}
  }

  function write(level, event, details = {}) {
    try {
      ensureDirectory();
      // 日志只接收调用方挑选后的诊断字段，不记录请求正文、令牌或完整 AI 输出。
      const record = JSON.stringify({
        at: new Date().toISOString(),
        level,
        event: String(event || 'unknown').slice(0, 120),
        ...details
      });
      let line = `${record}\n`;
      if (Buffer.byteLength(line) > maxBytes) line = `${JSON.stringify({ at: new Date().toISOString(), level, event: 'log_record_omitted', reason: 'record_too_large' })}\n`;
      rotate(Buffer.byteLength(line));
      fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
      if (options.mirror !== false && (process.stdout.isTTY || process.stderr.isTTY)) {
        const stream = level === 'error' ? process.stderr : process.stdout;
        stream.write(line);
      }
    } catch (_) {
      // 日志故障不能拖垮主流程，但错误级事件必须留下最小可见信号。
      if (level === 'error') {
        try { process.stderr.write(`${new Date().toISOString()} logger_write_failed event=${String(event || 'unknown').slice(0, 120)}\n`); } catch (_) {}
      }
    }
  }

  return {
    info: (event, details) => write('info', event, details),
    warn: (event, details) => write('warn', event, details),
    error: (event, details) => write('error', event, details),
    paths: () => ({ file, backup, maxBytes })
  };
}

const logger = createLogger();
module.exports = { createLogger, logger };
