const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const { saveAttachments, attachmentStorageUsage, removeSessionAttachments } = require('../src/attachments');

test('图片与旧版附件按任务计量，达到上限后拒绝继续增长', () => {
  const sessionId = `${Date.now()}999999`;
  const previousSessionLimit = config.MAX_ATTACHMENT_SESSION_BYTES;
  const previousGlobalLimit = config.MAX_ATTACHMENT_GLOBAL_BYTES;
  try {
    config.MAX_ATTACHMENT_SESSION_BYTES = 2;
    config.MAX_ATTACHMENT_GLOBAL_BYTES = 1024;
    saveAttachments(sessionId, [{ name: 'a.png', mimeType: 'image/png', data: 'data:image/png;base64,YQ==' }]);
    assert.equal(attachmentStorageUsage(sessionId).bytes, 1);
    assert.throws(() => saveAttachments(sessionId, [{ name: 'b.png', mimeType: 'image/png', data: 'data:image/png;base64,YmI=' }]), /50MB上限/);
    assert.equal(attachmentStorageUsage(sessionId).bytes, 1);
  } finally {
    config.MAX_ATTACHMENT_SESSION_BYTES = previousSessionLimit;
    config.MAX_ATTACHMENT_GLOBAL_BYTES = previousGlobalLimit;
    removeSessionAttachments(sessionId);
  }
});
