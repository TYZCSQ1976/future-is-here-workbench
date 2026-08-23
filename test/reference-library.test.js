const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createReferenceLibrary } = require('../src/reference-library');

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reference-library-'));
  const library = createReferenceLibrary({ root, chunkBytes: 4, maxSessionBytes: 100, maxGlobalBytes: 150, ...options });
  return { root, library, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function key(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('参考资料按分块续传、重复提交去重，并只向 AI 提供相关片段', async () => {
  const fx = fixture();
  try {
    const sessionId = '1234567890';
    const begun = fx.library.begin(sessionId, {
      name: '研究资料', uploadKey: key('research'),
      files: [{ path: 'notes.md', size: 8, mimeType: 'text/markdown' }]
    });
    assert.equal(begun.uploadedBytes, 0);
    assert.equal(fx.library.appendChunk(sessionId, begun.uploadId, 0, 0, Buffer.from('abcd')).uploadedBytes, 4);
    const retry = fx.library.begin(sessionId, {
      name: '研究资料', uploadKey: key('research'),
      files: [{ path: 'notes.md', size: 8, mimeType: 'text/markdown' }]
    });
    assert.equal(retry.resumed, true);
    assert.equal(retry.files[0].uploadedBytes, 4);
    assert.equal(fx.library.appendChunk(sessionId, retry.uploadId, 0, 0, Buffer.from('abcd')).duplicate, true);
    assert.throws(() => fx.library.appendChunk(sessionId, retry.uploadId, 0, 2, Buffer.from('zz')), /内容不一致/);
    fx.library.appendChunk(sessionId, retry.uploadId, 0, 4, Buffer.from('efgh'));
    const queued = fx.library.complete(sessionId, retry.uploadId);
    assert.equal(queued.state, 'processing');
    await fx.library.waitForIdle();
    const completed = fx.library.list(sessionId)[0];
    assert.equal(completed.parsedFileCount, 1);
    assert.equal(fx.library.complete(sessionId, retry.uploadId).duplicate, true);
    const context = fx.library.buildPromptContext(sessionId, 'abcd');
    assert.equal(context.usage.referencedFileCount, 1);
    assert.match(context.promptContext, /abcd/);
  } finally { fx.close(); }
});

test('参考资料有任务总量、全局总量和24小时未完成清理边界', () => {
  const fx = fixture({ incompleteTtlMs: 10_000 });
  try {
    fx.library.begin('1234567890', { name: 'a', uploadKey: key('a'), files: [{ path: 'a.txt', size: 90 }] });
    assert.throws(() => fx.library.begin('1234567890', { name: 'b', uploadKey: key('b'), files: [{ path: 'b.txt', size: 20 }] }), /100MB/);
    assert.throws(() => fx.library.begin('2234567890', { name: 'c', uploadKey: key('c'), files: [{ path: 'c.txt', size: 70 }] }), /500MB/);
    assert.equal(fx.library.cleanupIncomplete(Date.now() + 20_000), 1);
    assert.equal(fx.library.list('1234567890').length, 0);
  } finally { fx.close(); }
});

test('PDF与空文件都能完成：文字PDF可检索，扫描件限制明确显示', async () => {
  const fx = fixture({ pdfExtractor: () => 'PDF里的可检索文字' });
  try {
    const begun = fx.library.begin('1234567890', {
      name: 'PDF', uploadKey: key('pdf'),
      files: [{ path: 'paper.pdf', size: 4 }, { path: 'empty.txt', size: 0 }]
    });
    fx.library.appendChunk('1234567890', begun.uploadId, 0, 0, Buffer.from('%PDF'));
    fx.library.complete('1234567890', begun.uploadId);
    await fx.library.waitForIdle();
    const result = fx.library.list('1234567890')[0];
    assert.equal(result.files[0].parseStatus, 'parsed');
    assert.equal(result.files[1].parseStatus, 'failed');
    assert.match(fx.library.buildPromptContext('1234567890', '可检索').promptContext, /PDF里的可检索文字/);
  } finally { fx.close(); }
});

test('慢速PDF解析在后台运行，不阻塞完成接口，并可删除取消', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fx = fixture({ pdfExtractor: async () => { await gate; return '完成'; } });
  try {
    const begun = fx.library.begin('1234567890', {
      name: '慢PDF', uploadKey: key('slow-pdf'), files: [{ path: 'slow.pdf', size: 4 }]
    });
    fx.library.appendChunk('1234567890', begun.uploadId, 0, 0, Buffer.from('%PDF'));
    const queued = fx.library.complete('1234567890', begun.uploadId);
    assert.equal(queued.state, 'processing');
    assert.equal(fx.library.hasPending(), true);
    assert.equal(fx.library.list('1234567890')[0].state, 'processing');
    fx.library.remove('1234567890', begun.uploadId);
    release();
    await fx.library.waitForIdle();
    assert.equal(fx.library.hasPending(), false);
    assert.equal(fx.library.list('1234567890').length, 0);
  } finally { fx.close(); }
});

test('扫描PDF没有文字层时自动进入有界OCR，并记录解析来源', async () => {
  const fx = fixture({ pdfExtractor: async () => '', pdfOcrExtractor: async () => '扫描件中的中文内容' });
  try {
    const begun = fx.library.begin('1234567890', {
      name: '扫描件', uploadKey: key('ocr-pdf'), files: [{ path: 'scan.pdf', size: 4 }]
    });
    fx.library.appendChunk('1234567890', begun.uploadId, 0, 0, Buffer.from('%PDF'));
    fx.library.complete('1234567890', begun.uploadId);
    await fx.library.waitForIdle();
    const file = fx.library.list('1234567890')[0].files[0];
    assert.equal(file.parseStatus, 'parsed');
    assert.equal(file.parser, 'tesseract-ocr');
    assert.match(fx.library.buildPromptContext('1234567890', '中文').promptContext, /扫描件中的中文内容/);
  } finally { fx.close(); }
});
