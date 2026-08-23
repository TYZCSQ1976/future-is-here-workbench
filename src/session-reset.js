const { AppError } = require('./errors');
const { removeSessionAttachments } = require('./attachments');

function emptyWorkflow() {
  return {
    version: 1,
    objective: '',
    mode: null,
    phase: 'idle',
    round: 0,
    promptVersion: null,
    reliability: null,
    acceptedPlan: null,
    checkpoints: [],
    updatedAt: null
  };
}

function createSessionReset({ store, stateCenter, worktrees, jobs, referenceLibrary }) {
  async function reset(sessionId) {
    const before = store.getSession(sessionId);
    const activeRun = stateCenter.listRuns({ sessionId, states: ['queued', 'running', 'interrupted'] })[0];
    if (jobs.isActive(sessionId) || activeRun) {
      throw new AppError(409, 'JOB_IN_PROGRESS', '任务仍在运行，请先点击“终止”，再使用 /new');
    }

    const handles = stateCenter.listSessionWorkspaceHandles(sessionId, { unresolvedOnly: false });
    for (const handle of handles) {
      if (['delivered', 'discarded', 'empty'].includes(handle.state)) continue;
      try { worktrees.discard(handle.id); } catch (_) {}
    }

    const attachments = removeSessionAttachments(sessionId);
    const references = referenceLibrary.removeSession(sessionId);
    const durable = stateCenter.deleteSessionData(sessionId);
    const session = await store.updateSession(sessionId, (current) => {
      // 工作目录属于任务身份，/new 只换一张“白纸”，不解除已经做出的目录绑定。
      current.name = '新任务';
      current.type = current.lastMode || current.type || 'chat';
      current.team = null;
      current.discussionPlan = null;
      current.job = null;
      current.messages = [];
      current.workflow = emptyWorkflow();
      return current;
    });
    return {
      reset: true,
      workspace: session.workspace,
      cleared: {
        messages: before.messages.length,
        attachments: attachments.files || 0,
        attachmentBytes: attachments.bytes || 0,
        referenceUploads: references.uploads,
        referenceBytes: references.bytes,
        runs: durable.runs,
        traces: durable.runs,
        workspaceHandles: durable.workspaceHandles,
        proposedContextNodes: durable.proposedContextNodes
      },
      preserved: { workspace: Boolean(session.workspace), approvedMemory: true }
    };
  }

  return { reset };
}

module.exports = { createSessionReset };
