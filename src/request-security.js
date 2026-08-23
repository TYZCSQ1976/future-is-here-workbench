const crypto = require('node:crypto');

const config = require('./config');

function safeEqual(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normalizeHostName(value) {
  return String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
}

function isAuthorized(req, token = config.AUTH_TOKEN) {
  if (!token) return true;
  const header = req.headers.authorization || '';
  const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
  return safeEqual(supplied, token);
}

function isTrustedHost(req, { host = config.HOST, port = config.PORT } = {}) {
  const raw = String(req.headers.host || '').trim();
  if (!raw || /[\s/@]/.test(raw)) return false;
  try {
    const parsed = new URL(`http://${raw}`);
    const hostname = normalizeHostName(parsed.hostname);
    const configured = normalizeHostName(host);
    const loopbackNames = ['127.0.0.1', 'localhost', '::1'];
    const nameAllowed = loopbackNames.includes(configured) ? loopbackNames.includes(hostname) : hostname === configured;
    return nameAllowed && (!parsed.port || Number(parsed.port) === port);
  } catch (_) { return false; }
}

function isAllowedOrigin(req, settings) {
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;
  if (!isTrustedHost(req, settings)) return false;
  const origin = req.headers.origin;
  if (!origin) return !req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']).toLowerCase());
  try {
    const originUrl = new URL(origin);
    return ['http:', 'https:'].includes(originUrl.protocol)
      && originUrl.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch (_) { return false; }
}

module.exports = { safeEqual, isAuthorized, isTrustedHost, isAllowedOrigin };
