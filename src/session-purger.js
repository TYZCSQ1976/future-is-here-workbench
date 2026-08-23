const { AppError } = require('./errors');
const { removeSessionAttachments } = require('./attachments');

function createSessionPurger({ store, stateCenter, worktrees, jobs, referenceLibrary = null }) {
  async function purge(sessionId) {
    // 先确认任务仍存在，并阻止运行中的 Provider 继续写入正在删除的任务。
    store.getSession(sessionId);
    const durableRun = stateCenter.listRuns({ sessionId, states: ['queued', 'running', 'interrupted'] })[0];
    if (jobs.isActive(sessionId) || durableRun) {
      throw new AppError(409, 'JOB_IN_PROGRESS', '任务正在运行，请先点击“终止”后再删除');
    }

    // 删除任务时，任务专属隔离产物一并丢弃；正式工作目录始终不在这里。
    const handles = stateCenter.listSessionWorkspaceHandles(sessionId, { unresolvedOnly: false });
    for (const handle of handles) {
      if (['delivered', 'discarded'].includes(handle.state)) continue;
      try {
        worktrees.discard(handle.id);
      } catch (_) {
        // 源仓库可能已被移动或删除，git 清理失败不应让任务永远删不掉；
        // 控制面直接标记 discarded，残留的隔离目录由用户按需手动清理。
        try {
          stateCenter.updateWorkspaceHandle(handle.id, {
            state: 'discarded',
            metadata: { ...handle.metadata, discardedAt: new Date().toISOString(), cleanupIncomplete: true }
          });
        } catch (_) {}
      }
    }

    const attachments = removeSessionAttachments(sessionId);
    const references = referenceLibrary ? referenceLibrary.removeSession(sessionId) : { uploads: 0, bytes: 0 };
    const durable = stateCenter.deleteSessionData(sessionId);
    await store.deleteSession(sessionId);
    return { deleted: true, attachments, references, durable };
  }

  return { purge };
}

module.exports = { createSessionPurger };
