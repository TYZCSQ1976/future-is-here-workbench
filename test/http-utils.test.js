const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { openSse } = require('../src/http-utils');

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.frames = [];
    this.writableEnded = false;
    this.headersSent = false;
    this.acceptWrites = true;
  }
  setHeader() {}
  writeHead() { this.headersSent = true; }
  write(frame) { this.frames.push(frame); return this.acceptWrites; }
  end() { this.writableEnded = true; this.emit('close'); }
}

test('SSE 遇到背压时等待 drain 并保持事件顺序', () => {
  const response = new FakeResponse();
  response.acceptWrites = false;
  const stream = openSse(response);
  assert.equal(stream.send({ sequence: 1 }), true);
  assert.equal(stream.send({ sequence: 2 }), true);
  assert.equal(response.frames.length, 1);
  response.acceptWrites = true;
  response.emit('drain');
  assert.equal(response.frames.length, 2);
  assert.match(response.frames[0], /"sequence":1/);
  assert.match(response.frames[1], /"sequence":2/);
  stream.end();
});

test('SSE 慢连接超过积压上限后主动断开，避免内存无限增长', () => {
  const response = new FakeResponse();
  response.acceptWrites = false;
  const stream = openSse(response);
  stream.send({ sequence: 1 });
  let accepted = true;
  while (accepted) accepted = stream.send({ text: 'x'.repeat(32 * 1024) });
  assert.equal(response.writableEnded, true);
  assert.equal(stream.closed, true);
});
