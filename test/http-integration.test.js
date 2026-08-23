const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { server } = require('../server');

function request(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.once('error', reject);
    req.end();
  });
}

test('真实HTTP入口拒绝恶意Host与跨站Origin，并返回可识别健康信息', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const badHost = await request(port, '/healthz', { Host: 'evil.example:3456' });
    assert.equal(badHost.status, 421);
    assert.match(badHost.body, /UNTRUSTED_HOST/);

    const crossSite = await request(port, '/api/not-found', {
      Host: '127.0.0.1:3456', Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site'
    });
    assert.equal(crossSite.status, 403);
    assert.match(crossSite.body, /INVALID_ORIGIN/);

    const health = await request(port, '/healthz', { Host: '127.0.0.1:3456' });
    assert.equal(health.status, 200);
    const payload = JSON.parse(health.body);
    assert.equal(payload.service, 'future-is-here');
    assert.match(payload.instanceId, /^[0-9a-f-]{36}$/);
    assert.equal(typeof payload.state.schemaVersion, 'number');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
