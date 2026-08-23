const test = require('node:test');
const assert = require('node:assert/strict');

const { isAuthorized, isTrustedHost, isAllowedOrigin } = require('../src/request-security');

function request(headers = {}) { return { headers }; }

test('Host 校验只接受配置端口上的回环主机，拒绝注入和陌生主机', () => {
  const settings = { host: '127.0.0.1', port: 3456 };
  assert.equal(isTrustedHost(request({ host: 'localhost:3456' }), settings), true);
  assert.equal(isTrustedHost(request({ host: '[::1]:3456' }), settings), true);
  assert.equal(isTrustedHost(request({ host: 'evil.example:3456' }), settings), false);
  assert.equal(isTrustedHost(request({ host: 'localhost@evil.example' }), settings), false);
  assert.equal(isTrustedHost(request({ host: 'localhost:9999' }), settings), false);
});

test('Origin 与 Sec-Fetch-Site 必须同源，Bearer token 使用精确比较', () => {
  const settings = { host: '127.0.0.1', port: 3456 };
  assert.equal(isAllowedOrigin(request({ host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456', 'sec-fetch-site': 'same-origin' }), settings), true);
  assert.equal(isAllowedOrigin(request({ host: '127.0.0.1:3456', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' }), settings), false);
  assert.equal(isAuthorized(request({ authorization: 'Bearer exact-token' }), 'exact-token'), true);
  assert.equal(isAuthorized(request({ authorization: 'Bearer exact-token-extra' }), 'exact-token'), false);
  assert.equal(isAuthorized(request({}), 'exact-token'), false);
});
