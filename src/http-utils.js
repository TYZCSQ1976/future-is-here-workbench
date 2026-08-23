const { AppError } = require('./errors');
const config = require('./config');

let activeSseConnections = 0;

function parseJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > maxBytes) {
        req.resume();
        fail(new AppError(413, 'BODY_TOO_LARGE', '请求体太大了'));
        return;
      }
      body += chunk;
    });
    req.on('aborted', () => fail(new AppError(400, 'REQUEST_ABORTED', '请求已中断')));
    req.on('error', () => fail(new AppError(400, 'REQUEST_READ_FAILED', '请求读取失败')));
    req.on('end', () => {
      if (settled) return;
      try {
        const parsed = JSON.parse(body || '{}');
        settled = true;
        resolve(parsed);
      } catch (error) {
        fail(new AppError(400, 'INVALID_JSON', '数据格式错误', { cause: error }));
      }
    });
  });
}

function parseBinaryBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.resume();
        fail(new AppError(413, 'CHUNK_TOO_LARGE', '上传分块太大了'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('aborted', () => fail(new AppError(400, 'REQUEST_ABORTED', '上传已中断，可以重新选择同一文件夹继续')));
    req.on('error', () => fail(new AppError(400, 'REQUEST_READ_FAILED', '上传分块读取失败，可以重试')));
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
  });
}

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    // SSE 已经开流（200 + text/event-stream 头已发出）时无法再补发 JSON 错误体；
    // 此时 writeHead 会抛 ERR_HTTP_HEADERS_SENT，异常落入 .catch 回调会让进程崩溃。
    res.end();
    return;
  }
  setSecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, error, correlationId = null) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  const code = error.code || 'INTERNAL_ERROR';
  sendJson(res, status, { error: { code, message: error.expose === false ? '服务器内部错误' : error.message, correlationId } });
}

function openSse(res) {
  if (activeSseConnections >= config.MAX_SSE_CONNECTIONS) {
    throw new AppError(429, 'SSE_LIMIT_REACHED', '实时连接已达到上限，请稍后重试');
  }
  activeSseConnections += 1;
  setSecurityHeaders(res);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  let closed = false;
  let released = false;
  let heartbeat = null;
  let backpressured = false;
  let queuedBytes = 0;
  const pending = [];
  const abortController = new AbortController();
  const release = () => {
    if (released) return;
    released = true;
    activeSseConnections = Math.max(0, activeSseConnections - 1);
  };
  const onClose = () => {
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    // 浏览器断线只终止 SSE 连接，不应等同于用户明确点击“终止”；后台任务可通过独立取消接口停止。
    release();
  };
  const closeSlowConnection = () => {
    closed = true;
    pending.length = 0;
    queuedBytes = 0;
    if (heartbeat) clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  const writeFrame = (frame) => {
    if (closed || res.writableEnded) return false;
    if (backpressured) {
      const bytes = Buffer.byteLength(frame);
      if (queuedBytes + bytes > config.MAX_SSE_PENDING_BYTES) {
        closeSlowConnection();
        return false;
      }
      pending.push(frame);
      queuedBytes += bytes;
      return true;
    }
    backpressured = !res.write(frame);
    return true;
  };
  const onDrain = () => {
    if (closed || res.writableEnded) return;
    backpressured = false;
    while (!backpressured && pending.length) {
      const frame = pending.shift();
      queuedBytes -= Buffer.byteLength(frame);
      backpressured = !res.write(frame);
    }
  };
  res.on('close', onClose);
  res.on('drain', onDrain);
  heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return clearInterval(heartbeat);
    try { writeFrame(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
  }, 15_000);

  return {
    send(data) {
      if (closed || res.writableEnded) return false;
      try {
        return writeFrame(`data: ${JSON.stringify(data)}\n\n`);
      } catch (_) {
        closed = true;
        return false;
      }
    },
    end() {
      clearInterval(heartbeat);
      res.removeListener('close', onClose);
      res.removeListener('drain', onDrain);
      release();
      if (!res.writableEnded) res.end();
    },
    get signal() { return abortController.signal; },
    get closed() { return closed; }
  };
}

module.exports = { parseJsonBody, parseBinaryBody, sendJson, sendError, setSecurityHeaders, openSse };
