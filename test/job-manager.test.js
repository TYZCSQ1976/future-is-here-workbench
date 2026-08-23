const test = require('node:test');
const assert = require('node:assert/strict');

const { createJobManager } = require('../src/job-manager');

test('任务管理器同时限制单任务重复提交和全局并发数', () => {
  const jobs = createJobManager(2);
  const first = jobs.acquire('1000000000', 'chat');
  const second = jobs.acquire('1000000001', 'chat');
  assert.throws(() => jobs.acquire('1000000000', 'chat'), /正在运行/);
  assert.throws(() => jobs.acquire('1000000002', 'chat'), /并行任务已达到上限/);
  jobs.release(first.sessionId, first.id);
  jobs.release(second.sessionId, second.id);
  assert.equal(jobs.isActive('1000000000'), false);
});
