const crypto = require('crypto');
const { AppError } = require('./errors');
const config = require('./config');

function createJobManager(maxActiveJobs = config.MAX_ACTIVE_JOBS) {
  const active = new Map();

  function acquire(sessionId, kind) {
    if (active.has(sessionId)) {
      throw new AppError(409, 'JOB_IN_PROGRESS', '这个任务正在运行，请先等待它完成');
    }
    if (active.size >= maxActiveJobs) {
      throw new AppError(429, 'TOO_MANY_JOBS', '当前并行任务已达到上限，请稍后再试');
    }
    const job = { id: crypto.randomUUID(), sessionId, kind, startedAt: new Date().toISOString() };
    active.set(sessionId, job);
    return job;
  }

  function release(sessionId, jobId) {
    const current = active.get(sessionId);
    if (!jobId || !current || current.id === jobId) active.delete(sessionId);
  }

  function isActive(sessionId) {
    return active.has(sessionId);
  }

  return { acquire, release, isActive };
}

module.exports = { createJobManager };
