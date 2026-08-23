// 「未来已来」本地 AI 工作台
// 入口只负责 HTTP、认证、请求校验和用例编排；业务细节位于 src/。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./src/config');
const { AppError, asAppError } = require('./src/errors');
const { parseJsonBody, parseBinaryBody, sendJson, sendError, openSse, setSecurityHeaders } = require('./src/http-utils');
const { validateSessionId, validateSessionCreate, validateChatRequest, validateCollabRequest, validateTeamSuggestRequest, validateExecuteRequest, validateCancelRequest, validateRunCancelRequest, validateSessionViewRequest, validateWorkspaceCommandRequest, validateImportDiscussionRequest, validateContextNodeCreate, validateContextDecision, validateDeliveryDecision } = require('./src/validation');
const store = require('./src/session-store');
const { createJobManager } = require('./src/job-manager');
const { runDiscussion, runExecution, suggestTeam, buildMemberMemories, MODES } = require('./src/collaboration');
const providers = require('./src/providers');
const { allowedRoots, runWorkspaceCommand } = require('./src/workspace');
const { importDiscussionPlan } = require('./src/plan-transfer');
const { createStateCenter } = require('./src/state-center');
const { createRunEventBus } = require('./src/run-event-bus');
const { createChatRuntime } = require('./src/chat-runtime');
const { createAgentRegistry } = require('./src/agent-registry');
const { createWorktreeManager } = require('./src/worktree-manager');
const { getAgent } = require('./src/team');
const { createCollaborationLedger } = require('./src/collaboration-ledger');
const { assertJobTransition } = require('./src/workflow-machine');
const { readAttachment, saveAttachments, saveFolderFiles, folderPromptContext } = require('./src/attachments');
const { createSessionPurger } = require('./src/session-purger');
const { buildChatContext } = require('./src/context');
const { discoverVerificationPlan } = require('./src/verification-runner');
const { reconcileSessionJobs } = require('./src/job-reconcile');
const { listSessionTracePage } = require('./src/agent-trace');
const { createReferenceLibrary } = require('./src/reference-library');
const { createSessionReset } = require('./src/session-reset');
const { createConversationCommands } = require('./src/conversation-commands');
const { createStorageManager } = require('./src/storage-manager');
const { logger } = require('./src/logger');
const { createBackupManager, applyPendingRestore } = require('./src/backup-manager');
const { isAuthorized, isTrustedHost, isAllowedOrigin } = require('./src/request-security');

const jobs = createJobManager();
const restoredSnapshot = applyPendingRestore();
const stateCenter = createStateCenter();
const runEvents = createRunEventBus(stateCenter);
const agentRegistry = createAgentRegistry(providers);
const referenceLibrary = createReferenceLibrary();
referenceLibrary.cleanupIncomplete();
const chatRuntime = createChatRuntime({
  stateCenter,
  eventBus: runEvents,
  store,
  providers,
  referenceLibrary,
  getProviderHealth: async () => (await agentRegistry.inspect({ force: false })).providers
});
const worktrees = createWorktreeManager({ stateCenter });
const sessionPurger = createSessionPurger({ store, stateCenter, worktrees, jobs, referenceLibrary });
const sessionReset = createSessionReset({ store, stateCenter, worktrees, jobs, referenceLibrary });
const storageManager = createStorageManager({
  store,
  stateCenter,
  referenceLibrary,
  onError: (error) => logger.error('storage_maintenance_failed', { code: error.code || 'STORAGE_MAINTENANCE_FAILED' })
});
const backupManager = createBackupManager({
  stateCenter,
  hasActiveWork: () => Boolean(
    stateCenter.listRuns({ states: ['queued', 'running', 'interrupted'] })[0]
    || stateCenter.listWorkspaceHandlesByState(['prepared', 'awaiting_delivery', 'delivering', 'reconciliation_required'])[0]
    || referenceLibrary.hasPending()
  )
});
const conversationCommands = createConversationCommands({
  store, stateCenter, jobs, sessionReset, referenceLibrary, storageManager, backupManager,
  onRestoreRequested: () => setTimeout(() => shutdown('restore_requested').catch(() => {}), 250)
});
const collaborationLedger = createCollaborationLedger(stateCenter);
const activeControllers = new Map();
const runtimeIdentity = crypto.randomUUID();
const runtimeStatus = { startedAt: null, shuttingDown: false, lastStartupError: null };
let stopStorageMaintenance = null;
let shutdownPromise = null;

function writeProcessIdentity() {
  fs.mkdirSync(path.dirname(config.SERVER_PID_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${config.SERVER_PID_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({
    service: 'future-is-here', pid: process.pid, instanceId: runtimeIdentity,
    host: config.HOST, port: config.PORT, startedAt: runtimeStatus.startedAt
  }, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, config.SERVER_PID_PATH);
}

function removeProcessIdentity() {
  try {
    const current = JSON.parse(fs.readFileSync(config.SERVER_PID_PATH, 'utf8'));
    if (current.pid === process.pid && current.instanceId === runtimeIdentity) fs.rmSync(config.SERVER_PID_PATH, { force: true });
  } catch (_) {}
}

function unresolvedWorkspaceHandles(sessionId) {
  return stateCenter.listSessionWorkspaceHandles(sessionId, { unresolvedOnly: true });
}

function assertNoPendingWorkspaceArtifact(sessionId) {
  if (unresolvedWorkspaceHandles(sessionId).length > 0) {
    throw new AppError(409, 'WORKSPACE_ARTIFACT_PENDING', '请先交付或丢弃上一次隔离产物，再继续这个任务');
  }
}

function getPath(req) {
  try {
    return new URL(req.url, 'http://localhost').pathname;
  } catch (_) {
    throw new AppError(400, 'INVALID_URL', '请求地址无效');
  }
}

function readStatic(res, fileName, contentType) {
  const filePath = path.join(config.PUBLIC_DIR, fileName);
  try {
    const content = fs.readFileSync(filePath);
    setSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch (_) {
    sendJson(res, 404, { error: { code: 'STATIC_NOT_FOUND', message: '资源不存在' } });
  }
}

function createJobRecord(runtimeJob, kind, extra = {}) {
  return {
    id: runtimeJob.id,
    kind,
    state: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra
  };
}

async function updatePersistentJob(sessionId, jobId, patch, expectedStates = null) {
  try {
    return await store.updateSession(sessionId, (session) => {
      if (!session.job || session.job.id !== jobId) {
        throw new AppError(409, 'JOB_STATE_CHANGED', '任务状态已经发生变化，请刷新页面');
      }
      if (expectedStates && !expectedStates.includes(session.job.state)) {
        throw new AppError(409, 'JOB_STATE_CHANGED', '任务状态已经发生变化，请刷新页面');
      }
      if (patch.state) assertJobTransition(session.job.state, patch.state);
      session.job = { ...session.job, ...patch, updatedAt: new Date().toISOString() };
      return session;
    });
  } catch (error) {
    if (error.code === 'SESSION_NOT_FOUND') return null;
    throw error;
  }
}

async function markJobFailed(sessionId, jobId, error) {
  const appError = asAppError(error);
  try {
    await updatePersistentJob(sessionId, jobId, {
      state: 'failed',
      error: { code: appError.code, message: appError.message }
    });
  } catch (_) {}
}

function resolveTaskContext(session, query) {
  return stateCenter.resolveContext({
    workspacePath: session.workspace?.path || config.PROJECT_ROOT,
    query
  });
}

function resolveVerificationPlan(session) {
  if (!session.workspace?.path) {
    const unsignedPlan = {
      schemaVersion: 2,
      kind: 'deterministic_project_checks',
      manifest: 'package.json',
      required: false,
      reason: 'WORKSPACE_NOT_BOUND',
      commands: [],
      integrity: { algorithm: 'sha256', files: [], digest: null, error: null }
    };
    return { ...unsignedPlan, hash: crypto.createHash('sha256').update(JSON.stringify(unsignedPlan)).digest('hex') };
  }
  return discoverVerificationPlan(session.workspace.path);
}

function proposeContextFromPlan({ session, runId, discussion }) {
  try {
    return stateCenter.createContextNode({
      scope: session.workspace?.path || config.PROJECT_ROOT,
      type: 'decision',
      title: `候选方案：${String(discussion.planArtifact?.summary || session.name).slice(0, 100)}`,
      content: JSON.stringify({
        summary: discussion.planArtifact?.summary,
        facts: discussion.planArtifact?.facts,
        assumptions: discussion.planArtifact?.assumptions,
        risks: discussion.planArtifact?.risks,
        acceptanceCriteria: discussion.planArtifact?.acceptanceCriteria
      }, null, 2).slice(0, 12_000),
      source: `run:${runId}`,
      status: 'proposed',
      metadata: { promptVersion: discussion.promptVersion, planHash: crypto.createHash('sha256').update(discussion.plan).digest('hex') }
    });
  } catch (_) {
    return null;
  }
}

async function handleChat(req, res) {
  const data = validateChatRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  const requestId = data.requestId || req.headers['idempotency-key'] || crypto.randomUUID();
  const run = await chatRuntime.submit({ ...data, requestId });
  return streamRunEvents(req, res, run.id, 0);
}

function prepareUserAttachments(sessionId, data, query) {
  const attachments = saveAttachments(sessionId, data.attachments || []);
  const selectedReference = data.folder?.uploadId
    ? referenceLibrary.list(sessionId).find((item) => item.uploadId === data.folder.uploadId)
    : null;
  if (data.folder?.uploadId && !selectedReference) throw new AppError(404, 'REFERENCE_UPLOAD_NOT_FOUND', '所选参考资料不存在或已经被清理');
  if (selectedReference && selectedReference.state !== 'complete') throw new AppError(409, 'REFERENCE_UPLOAD_INCOMPLETE', '参考资料仍在上传或解析，请稍后再发送');
  const legacyFolder = data.folder?.files ? saveFolderFiles(sessionId, data.folder) : null;
  const reference = referenceLibrary.buildPromptContext(sessionId, query);
  const promptContext = [folderPromptContext(legacyFolder), reference.promptContext].filter(Boolean).join('\n\n');
  const folder = promptContext ? { name: selectedReference?.name || legacyFolder?.name || '任务参考资料', promptContext } : null;
  return { attachments, folder, referenceUsage: reference.usage };
}

async function handleRunCancel(req, res) {
  const data = validateRunCancelRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  const run = stateCenter.getRun(data.runId);
  if (run.sessionId !== data.sessionId) throw new AppError(403, 'RUN_OWNERSHIP_MISMATCH', '运行不属于当前任务');
  if (run.kind === 'chat') {
    const cancelled = chatRuntime.cancel(data.runId);
    return sendJson(res, 200, { ok: true, state: cancelled.state });
  }
  const controller = activeControllers.get(data.runId);
  if (!controller) throw new AppError(409, 'RUN_NOT_ACTIVE', '当前运行已经结束或无法终止');
  controller.abort();
  try { stateCenter.updateRun(data.runId, { expectedStates: ['queued', 'running', 'interrupted'], state: 'cancelled', error: { code: 'RUN_CANCELLED', message: '已由用户终止' } }); } catch (_) {}
  runEvents.publish(data.runId, 'run_cancelled', { message: '已由用户终止' });
  sendJson(res, 200, { ok: true, state: 'cancelled' });
}

function registerController(runId, controller, stream) {
  activeControllers.set(runId, controller);
  stream.signal.addEventListener('abort', () => controller.abort(), { once: true });
}

function publicRun(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    kind: run.kind,
    state: run.state,
    result: run.result,
    error: run.error,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    latestSequence: stateCenter.latestSequence(run.id),
    agents: agentRegistry.describeRunAgents(stateCenter, run.id)
  };
}

function streamRunEvents(req, res, runId, afterSequence = 0) {
  const run = stateCenter.getRun(runId);
  const stream = openSse(res);
  let finished = false;
  let unsubscribe = () => {};
  return new Promise((resolve) => {
    const finish = () => {
      if (finished) return;
      finished = true;
      unsubscribe();
      stream.end();
      resolve();
    };
    const endsStream = (type) => ['chat_complete', 'chat_error', 'run_cancelled', 'gate', 'plan_ready', 'delivery_gate', 'delivery_completed', 'delivery_discarded', 'complete', 'error'].includes(type);
    let deliveredSequence = Math.max(0, Number(afterSequence) || 0);
    const deliver = (event) => {
      if (event.sequence <= deliveredSequence) return; // 订阅补读与即时广播可能重复投递同一事件
      if (!stream.send({ ...event.payload, type: event.type, runId: event.runId, sequence: event.sequence, eventAt: event.createdAt })) return finish();
      deliveredSequence = event.sequence;
      if (endsStream(event.type)) finish();
    };
    let latestDelivered = Math.max(0, Number(afterSequence) || 0);
    let reachedEnd = false;
    let replayBytes = 0;
    let replayTruncated = false;
    for (const event of stateCenter.listEvents(runId, latestDelivered, config.MAX_SSE_REPLAY_EVENTS)) {
      const payload = { ...event.payload, type: event.type, runId: event.runId, sequence: event.sequence, eventAt: event.createdAt };
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      if (replayBytes + bytes > config.MAX_SSE_REPLAY_BYTES) { replayTruncated = true; break; }
      latestDelivered = event.sequence;
      replayBytes += bytes;
      if (!stream.send(payload)) return finish();
      reachedEnd = reachedEnd || endsStream(event.type);
    }
    res.once('close', finish);
    deliveredSequence = latestDelivered; // 重放结束后同步去重游标，避免补读重复推送
    const current = stateCenter.getRun(runId);
    if (replayTruncated) {
      stream.send({ type: 'replay_truncated', runId, sequence: latestDelivered, message: '历史事件较多，请从当前游标继续恢复' });
      return finish();
    }
    if (reachedEnd || !stateCenter.isActiveState(current.state)) return finish();
    // 即时事件（token 流等）：不持久化，直接推给当前 SSE 连接。
    const unsubscribeLive = runEvents.onLive(runId, (event) => {
      if (finished) return;
      if (!stream.send({ ...event.payload, type: event.type, runId: event.runId, eventAt: event.createdAt })) return finish();
    });
    const unsubscribeEvents = runEvents.subscribe(runId, latestDelivered, deliver, { replay: false });
    unsubscribe = () => { unsubscribeEvents(); unsubscribeLive(); };
    // 补读“重放之后、订阅注册之前”落库的事件，否则该窗口内的终止事件两边都拿不到，客户端会永远等待。
    if (!finished) {
      for (const event of stateCenter.listEvents(runId, deliveredSequence, config.MAX_SSE_REPLAY_EVENTS)) {
        deliver(event);
        if (finished) break;
      }
    }
    if (current.state === 'interrupted') chatRuntime.schedule(runId);
  });
}

async function handleTeamSuggestion(req, res) {
  const data = validateTeamSuggestRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  const abortController = new AbortController();
  const onClose = () => { if (!res.writableEnded) abortController.abort(); };
  res.on('close', onClose);
  try {
    const result = await suggestTeam({
      goal: data.goal,
      modeKey: data.mode,
      plannerProvider: data.plannerProvider,
      desiredCount: data.desiredCount,
      providers,
      signal: abortController.signal
    });
    sendJson(res, 200, result);
  } finally {
    res.removeListener('close', onClose);
  }
}

async function prepareCollaboration(data, runtimeJob, purpose = 'collaboration') {
  store.getSession(data.sessionId);
  return store.updateSession(data.sessionId, (current) => {
    if (current.messages.length >= config.MAX_STORED_MESSAGES) {
      throw new AppError(413, 'SESSION_TOO_LARGE', '这个任务的对话太长了，请新建任务继续');
    }
    if (current.messages.length === 0) {
      current.name = `${purpose === 'discussion' ? '讨论' : '协作'}: ${data.goal.slice(0, 15)}${data.goal.length > 15 ? '…' : ''}`;
    }
    current.type = purpose === 'discussion' ? 'discussion' : 'collab';
    current.lastMode = current.type;
    current.collabMode = data.mode;
    current.team = data.team;
    current.messages.push({ role: 'user', text: data.goal, agent: null, interactionMode: current.type, timestamp: new Date().toISOString() });
    current.workflow = {
      ...current.workflow,
      objective: data.goal,
      mode: data.mode,
      phase: 'starting',
      round: 0,
      reliability: null,
      acceptedPlan: null,
      updatedAt: new Date().toISOString()
    };
    current.job = createJobRecord(runtimeJob, purpose, { mode: data.mode, gateMode: data.gateMode, goal: data.goal, team: data.team });
    return current;
  });
}

async function handleCollaboration(req, res) {
  const data = validateCollabRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  store.getSession(data.sessionId);
  assertNoPendingWorkspaceArtifact(data.sessionId);
  const runtimeJob = jobs.acquire(data.sessionId, 'collaboration');
  let durableRun = null;
  let stream;
  let controller;

  try {
    // 占坑之后的所有可抛错步骤都必须留在 try 内，否则异常逃逸会让任务槽永不释放。
    const userAttachments = prepareUserAttachments(data.sessionId, data, data.goal);
    durableRun = stateCenter.createRun({
      id: runtimeJob.id,
      sessionId: data.sessionId,
      kind: 'collaboration',
      idempotencyKey: `collaboration:${runtimeJob.id}`,
      input: { goal: data.goal, mode: data.mode, gateMode: data.gateMode, team: data.team },
      agents: data.team.agents
    }).run;
    const preparedSession = await prepareCollaboration(data, runtimeJob);
    const contextBundle = resolveTaskContext(preparedSession, data.goal);
    const conversationContext = buildChatContext(preparedSession.messages.slice(0, -1), data.goal);
    const memberMemories = buildMemberMemories(preparedSession.messages.slice(0, -1), data.team);
    stream = openSse(res);
    controller = new AbortController();
    registerController(durableRun.id, controller, stream);
    stateCenter.updateRun(durableRun.id, { expectedStates: ['queued'], state: 'running' });
    const sendEvent = (event) => {
      const persisted = runEvents.publish(durableRun.id, event.type || 'collaboration_event', event);
      stream.send({ ...event, runId: durableRun.id, sequence: persisted.sequence });
    };
    sendEvent({ type: 'reference_context', usage: userAttachments.referenceUsage });

    try {
      const discussion = await runDiscussion({
        sessionId: data.sessionId,
        goal: data.goal,
        modeKey: data.mode,
        team: data.team,
        sendEvent,
        store,
        providers,
        signal: controller.signal,
        contextBundle,
        conversationContext,
        memberMemories,
        ledger: collaborationLedger,
        runId: durableRun.id,
        attachments: userAttachments.attachments,
        folder: userAttachments.folder,
        workspacePath: preparedSession.workspace?.path || null
      });
      const planHash = crypto.createHash('sha256').update(discussion.plan).digest('hex');
      await updatePersistentJob(data.sessionId, runtimeJob.id, {
        state: 'waiting_approval',
        plan: discussion.plan,
        planArtifact: discussion.planArtifact,
        reviewArtifacts: discussion.reviewArtifacts,
        team: discussion.team,
        planHash,
        round: discussion.round,
        reliability: discussion.reliability,
        promptVersion: discussion.promptVersion,
        contextDigest: contextBundle.digest,
        contextNodeIds: contextBundle.nodes.map((node) => node.id),
        deterministicVerificationPlan: resolveVerificationPlan(preparedSession)
      });
      const proposedContext = proposeContextFromPlan({ session: preparedSession, runId: runtimeJob.id, discussion });
      if (proposedContext) sendEvent({ type: 'context_proposed', node: proposedContext, message: '团队形成了一条待你审核的 Context Tree 建议' });
      if (data.gateMode === 'auto') {
        sendEvent({ type: 'warning', message: '隔离实施和最终交付需要可追溯的人工决定，自动闸门已降级为人工确认' });
      }
      const approvedJob = store.getSession(data.sessionId).job;
      stateCenter.updateRun(durableRun.id, {
        state: 'waiting_approval',
        result: {
          reliability: discussion.reliability,
          inbox: discussion.inbox,
          planHash,
          deterministicVerificationPlan: approvedJob.deterministicVerificationPlan
        }
      });
      sendEvent({
        type: 'gate',
        plan: discussion.plan,
        jobId: runtimeJob.id,
        planHash,
        contextDigest: contextBundle.digest,
        deterministicVerificationPlan: approvedJob.deterministicVerificationPlan,
        reliability: discussion.reliability,
        team: discussion.team
      });
    } catch (error) {
      if (controller.signal.aborted || stateCenter.getRun(durableRun.id).state === 'cancelled') {
        await updatePersistentJob(data.sessionId, runtimeJob.id, { state: 'cancelled', error: { code: 'RUN_CANCELLED', message: '已由用户终止' } });
        return;
      }
      await markJobFailed(data.sessionId, runtimeJob.id, error);
      stateCenter.updateRun(durableRun.id, { state: 'failed', error: { code: error.code || 'COLLABORATION_FAILED', message: asAppError(error).message } });
      sendEvent({ type: 'error', message: asAppError(error).message });
    }
  } catch (error) {
    if (durableRun && stateCenter.getRun(durableRun.id).state === 'cancelled') return;
    jobs.release(data.sessionId, runtimeJob.id);
    if (durableRun) {
      try { stateCenter.updateRun(durableRun.id, { state: 'failed', error: { code: error.code || 'COLLABORATION_START_FAILED', message: asAppError(error).message } }); } catch (_) {}
    }
    if (stream) stream.send({ type: 'error', message: asAppError(error).message, runId: durableRun ? durableRun.id : null });
    else throw error;
  } finally {
    if (durableRun) activeControllers.delete(durableRun.id);
    jobs.release(data.sessionId, runtimeJob.id);
    if (stream) stream.end();
  }
}

async function handleDiscussion(req, res) {
  const data = validateCollabRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  store.getSession(data.sessionId);
  assertNoPendingWorkspaceArtifact(data.sessionId);
  const runtimeJob = jobs.acquire(data.sessionId, 'discussion');
  let durableRun = null;
  let stream;
  let controller;
  try {
    // 占坑之后的所有可抛错步骤都必须留在 try 内，否则异常逃逸会让任务槽永不释放。
    const userAttachments = prepareUserAttachments(data.sessionId, data, data.goal);
    durableRun = stateCenter.createRun({
      id: runtimeJob.id,
      sessionId: data.sessionId,
      kind: 'discussion',
      idempotencyKey: `discussion:${runtimeJob.id}`,
      input: { goal: data.goal, mode: data.mode, team: data.team },
      agents: data.team.agents
    }).run;
    const preparedSession = await prepareCollaboration(data, runtimeJob, 'discussion');
    const contextBundle = resolveTaskContext(preparedSession, data.goal);
    const conversationContext = buildChatContext(preparedSession.messages.slice(0, -1), data.goal);
    const memberMemories = buildMemberMemories(preparedSession.messages.slice(0, -1), data.team);
    stream = openSse(res);
    controller = new AbortController();
    registerController(durableRun.id, controller, stream);
    stateCenter.updateRun(durableRun.id, { expectedStates: ['queued'], state: 'running' });
    const sendEvent = (event) => {
      const persisted = runEvents.publish(durableRun.id, event.type || 'discussion_event', event);
      stream.send({ ...event, runId: durableRun.id, sequence: persisted.sequence });
    };
    sendEvent({ type: 'reference_context', usage: userAttachments.referenceUsage });
    const discussion = await runDiscussion({
      sessionId: data.sessionId,
      goal: data.goal,
      modeKey: data.mode,
      team: data.team,
      sendEvent,
      store,
      providers,
      signal: controller.signal,
      contextBundle,
      conversationContext,
      memberMemories,
        ledger: collaborationLedger,
        runId: durableRun.id,
        attachments: userAttachments.attachments,
        folder: userAttachments.folder,
        workspacePath: preparedSession.workspace?.path || null
    });
    const planHash = crypto.createHash('sha256').update(discussion.plan).digest('hex');
    const discussionPlan = {
      goal: data.goal,
      mode: data.mode,
      plan: discussion.plan,
      planArtifact: discussion.planArtifact,
      reviewArtifacts: discussion.reviewArtifacts,
      reliability: discussion.reliability,
      team: discussion.team,
      planHash,
      promptVersion: discussion.promptVersion,
      createdAt: new Date().toISOString()
    };
    await store.updateSession(data.sessionId, (session) => {
      if (!session.job || session.job.id !== runtimeJob.id) throw new AppError(409, 'JOB_STATE_CHANGED', '讨论任务状态已经变化');
      session.discussionPlan = discussionPlan;
      session.job = { ...session.job, state: 'plan_ready', planHash, updatedAt: new Date().toISOString() };
      return session;
    });
    const proposedContext = proposeContextFromPlan({ session: preparedSession, runId: runtimeJob.id, discussion });
    if (proposedContext) sendEvent({ type: 'context_proposed', node: proposedContext, message: '团队形成了一条待你审核的 Context Tree 建议' });
    stateCenter.updateRun(durableRun.id, { state: 'plan_ready', result: { planHash, reliability: discussion.reliability, inbox: discussion.inbox } });
    sendEvent({ type: 'plan_ready', discussionPlan });
  } catch (error) {
    if (durableRun && stateCenter.getRun(durableRun.id).state === 'cancelled') return;
    await markJobFailed(data.sessionId, runtimeJob.id, error);
    if (durableRun) {
      stateCenter.updateRun(durableRun.id, { state: 'failed', error: { code: error.code || 'DISCUSSION_FAILED', message: asAppError(error).message } });
    }
    if (stream) {
      const persisted = runEvents.publish(durableRun.id, 'error', { message: asAppError(error).message });
      stream.send({ type: 'error', message: asAppError(error).message, runId: durableRun.id, sequence: persisted.sequence });
    }
    else throw error;
  } finally {
    if (durableRun) activeControllers.delete(durableRun.id);
    jobs.release(data.sessionId, runtimeJob.id);
    if (stream) stream.end();
  }
}

async function handleImportDiscussion(req, res) {
  const data = validateImportDiscussionRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  const source = store.getSession(data.sourceSessionId);
  const plan = source.discussionPlan;
  const contextBundle = resolveTaskContext(source, plan?.plan || plan?.goal || '');
  const imported = await importDiscussionPlan(store, data.sourceSessionId, {
    contextDigest: contextBundle.digest,
    contextNodeIds: contextBundle.nodes.map((node) => node.id),
    deterministicVerificationPlan: resolveVerificationPlan(source)
  });
  sendJson(res, 201, imported);
}

async function handleWorkspaceCommand(req, res) {
  const data = validateWorkspaceCommandRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  const session = store.getSession(data.sessionId);
  const durableRun = stateCenter.listRuns({ sessionId: data.sessionId, states: ['queued', 'running', 'interrupted'] })[0];
  if (jobs.isActive(data.sessionId) || durableRun) throw new AppError(409, 'JOB_IN_PROGRESS', '任务运行期间不能切换工作目录');
  if (unresolvedWorkspaceHandles(data.sessionId).length > 0) throw new AppError(409, 'DELIVERY_DECISION_REQUIRED', '请先交付或丢弃隔离产物，再切换工作目录');
  const result = runWorkspaceCommand(data.command, session.workspace?.path || null);
  if (result.command !== 'cd') {
    return sendJson(res, 200, { ...result, workspace: session.workspace, allowedRoots: allowedRoots() });
  }
  const updated = await store.updateSession(data.sessionId, (current) => {
    if (current.workspace?.path) throw new AppError(409, 'WORKSPACE_LOCKED', '这个任务的工作目录已经锁定，不能更换');
    current.workspace = { path: result.workspacePath, boundAt: new Date().toISOString() };
    return current;
  });
  return sendJson(res, 200, { ...result, workspace: updated.workspace, allowedRoots: allowedRoots() });
}

async function handleExecute(req, res) {
  const data = validateExecuteRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  const session = store.getSession(data.sessionId);
  const job = session.job;
  if (!job || job.state !== 'waiting_approval' || !job.plan || !job.mode) {
    throw new AppError(409, 'APPROVAL_REQUIRED', '当前任务没有等待确认的方案');
  }
  if (data.expectedJobId !== job.id || data.expectedPlanHash !== job.planHash || data.expectedContextDigest !== job.contextDigest) {
    throw new AppError(409, 'APPROVAL_VERSION_CHANGED', '你确认的方案版本已经变化，请重新查看后再批准');
  }
  if (job.deterministicVerificationPlan?.hash
      && data.expectedDeterministicVerificationPlanHash !== job.deterministicVerificationPlan.hash) {
    throw new AppError(409, 'VERIFICATION_APPROVAL_CHANGED', '你批准的系统检查计划已经变化，请重新查看后再执行');
  }
  if (data.plan) {
    const planHash = crypto.createHash('sha256').update(data.plan).digest('hex');
    if (planHash !== data.expectedPlanHash) throw new AppError(409, 'PLAN_CHANGED', '确认的方案已发生变化，请重新发起协作');
  }
  if (job.reliability?.requiresUserDecision && !data.acknowledgeDisagreement) {
    throw new AppError(409, 'DISAGREEMENT_ACK_REQUIRED', '团队仍有分歧，请明确确认你已了解分歧');
  }
  if (!session.workspace?.path) throw new AppError(409, 'WORKSPACE_REQUIRED', '执行前必须先使用 cd 绑定一个明确的工作目录');

  const runtimeJob = jobs.acquire(data.sessionId, 'execution');
  let durableExecution = null;
  let workspaceHandle;
  let stream;
  let controller;
  try {
    // 占坑之后的所有可抛错步骤都必须留在 try 内，否则异常逃逸会让任务槽永不释放。
    const executionTeam = job.team || session.team;
    const lead = getAgent(executionTeam, executionTeam.leadAgentId);
    const executionAttempt = Number(job.executionAttempt || 0) + 1;
    // 指纹必须用与审批时相同的 query（goal）重算，用 plan 会因分词差异误报上下文变化。
    const contextBundle = resolveTaskContext(session, job.goal || job.plan);
    if (contextBundle.digest !== data.expectedContextDigest) {
      throw new AppError(409, 'CONTEXT_CHANGED_AFTER_APPROVAL', '团队记忆在方案确认后发生变化，请重新讨论或重新确认方案');
    }
    durableExecution = stateCenter.createRun({
      sessionId: data.sessionId,
      kind: 'execution',
      idempotencyKey: `execution:${job.id}:${executionAttempt}`,
      input: {
        approvedJobId: job.id,
        approvedPlanHash: job.planHash,
        workspacePath: session.workspace.path,
        leadAgentId: lead.id,
        contextDigest: contextBundle.digest,
        contextNodeIds: contextBundle.nodes.map((node) => node.id),
        deterministicVerificationPlanHash: job.deterministicVerificationPlan?.hash || null
      },
      agents: executionTeam.agents
    }).run;
    try {
      workspaceHandle = worktrees.prepare({
        runId: durableExecution.id,
        sessionId: data.sessionId,
        agentId: lead.id,
        workspacePath: session.workspace.path
      });
    } catch (error) {
      stateCenter.updateRun(durableExecution.id, { state: 'failed', error: { code: error.code || 'WORKTREE_PREPARE_FAILED', message: error.message } });
      await updatePersistentJob(data.sessionId, job.id, {
        state: 'waiting_approval',
        executionAttempt,
        error: { code: error.code || 'WORKTREE_PREPARE_FAILED', message: error.message }
      }, ['waiting_approval']);
      throw error;
    }
    await updatePersistentJob(data.sessionId, job.id, {
      state: 'executing',
      executionRunId: durableExecution.id,
      executionAttempt,
      workspaceHandleId: workspaceHandle.id,
      executionWorkspace: { kind: workspaceHandle.kind, sourceRoot: workspaceHandle.sourceRoot, baseRevision: workspaceHandle.baseRevision },
      contextDigest: contextBundle.digest,
      contextNodeIds: contextBundle.nodes.map((node) => node.id)
    }, ['waiting_approval']);
    stateCenter.updateRun(durableExecution.id, { expectedStates: ['queued', 'interrupted'], state: 'running' });
    // 必须先把“本次可写执行已开始”持久化，再调用 Provider。
    // 若进程在 Provider 返回前退出，启动恢复会看到未结清栅栏并拒绝自动重放。
    stateCenter.armExecutionFence({
      runId: durableExecution.id,
      sessionId: data.sessionId,
      jobId: job.id,
      planHash: job.planHash,
      contextDigest: contextBundle.digest,
      workspaceHandleId: workspaceHandle.id,
      provider: lead.provider
    });
    stream = openSse(res);
    controller = new AbortController();
    registerController(durableExecution.id, controller, stream);
    const sendExecutionEvent = (event) => {
      const persisted = runEvents.publish(durableExecution.id, event.type || 'execution_event', event);
      stream.send({ ...event, runId: durableExecution.id, sequence: persisted.sequence });
    };
    const execution = await runExecution({
      sessionId: data.sessionId,
      plan: job.plan,
      planArtifact: job.planArtifact,
      modeKey: job.mode,
      team: executionTeam,
      sendEvent: sendExecutionEvent,
      store,
      providers,
      workspacePath: workspaceHandle.isolatedPath,
      signal: controller.signal,
      contextBundle,
      deterministicVerificationPlan: job.deterministicVerificationPlan || null
    });
    if (!execution.ok) {
      // 用户在执行阶段取消时，runExecution 会把 PROVIDER_CANCELLED 折叠成 {ok:false}；
      // 必须先识别取消，否则已取消的任务会被改写成 needs_revision/failed。
      if (controller.signal.aborted || stateCenter.getRun(durableExecution.id).state === 'cancelled') {
        let discarded = false;
        let discardError = null;
        try { worktrees.discard(workspaceHandle.id); discarded = true; } catch (error) { discardError = error; }
        try {
          await updatePersistentJob(data.sessionId, job.id, {
            state: discarded ? 'cancelled' : 'interrupted',
            workspaceHandleId: discarded ? null : workspaceHandle.id,
            error: discarded
              ? { code: 'RUN_CANCELLED', message: '已由用户终止' }
              : { code: discardError?.code || 'WORKTREE_DISCARD_FAILED', message: '任务已停止，但隔离产物回收失败，请手动丢弃' }
          });
        } catch (_) {}
        if (discarded) {
          stateCenter.settleExecutionFence(durableExecution.id, { disposition: 'discarded_after_cancel' });
          sendExecutionEvent({ type: 'run_cancelled', message: '已由用户终止' });
        } else {
          stateCenter.updateRun(durableExecution.id, {
            state: 'interrupted',
            error: { code: discardError?.code || 'WORKTREE_DISCARD_FAILED', message: '任务已停止，但隔离产物回收失败，请手动丢弃' }
          });
          sendExecutionEvent({ type: 'error', message: '任务已停止，但隔离产物回收失败；系统已保留产物和防重放栅栏' });
        }
        return;
      }
      const needsRevision = execution.verification && !execution.verification.passed;
      let isolationEvidence = null;
      let emptyWorkspaceDiscarded = false;
      try {
        isolationEvidence = worktrees.inspect(workspaceHandle.id).evidence;
        if (!isolationEvidence.changedCount) {
          worktrees.discard(workspaceHandle.id);
          emptyWorkspaceDiscarded = true;
        }
      } catch (_) {}
      await updatePersistentJob(data.sessionId, job.id, {
        state: needsRevision ? 'needs_revision' : 'failed',
        verification: execution.verification,
        isolationEvidence,
        workspaceHandleId: isolationEvidence?.changedCount ? workspaceHandle.id : null,
        error: { code: needsRevision ? 'VERIFICATION_NOT_PASSED' : 'EXECUTION_PARTIAL_FAILURE', message: needsRevision ? '独立验证未通过，需要修订' : '执行阶段有 Provider 失败' }
      });
      stateCenter.updateRun(durableExecution.id, {
        state: needsRevision ? 'needs_revision' : 'failed',
        result: { verification: execution.verification, changes: execution.changes, isolationEvidence },
        error: { code: needsRevision ? 'VERIFICATION_NOT_PASSED' : 'EXECUTION_PARTIAL_FAILURE', message: needsRevision ? '独立验证未通过，需要修订' : '执行阶段有 Provider 失败' }
      });
      if (emptyWorkspaceDiscarded) {
        stateCenter.settleExecutionFence(durableExecution.id, {
          disposition: 'discarded_without_changes',
          evidence: { changedCount: 0 }
        });
      }
      sendExecutionEvent({ type: 'error', message: needsRevision ? '独立验证没有通过，隔离产物不会进入正式工作区' : '执行阶段没有完整成功，请查看上面的失败信息' });
    } else {
      const inspected = worktrees.inspect(workspaceHandle.id);
      if (!inspected.evidence.changedCount) {
        worktrees.discard(workspaceHandle.id);
        const noChanges = { code: 'NO_DELIVERABLE_CHANGES', message: '执行没有产生可交付的 Git 修改，请调整方案后重试' };
        await updatePersistentJob(data.sessionId, job.id, { state: 'needs_revision', verification: execution.verification, isolationEvidence: inspected.evidence, workspaceHandleId: null, error: noChanges });
        stateCenter.updateRun(durableExecution.id, { state: 'needs_revision', result: { verification: execution.verification, changes: execution.changes, isolationEvidence: inspected.evidence }, error: noChanges });
        stateCenter.settleExecutionFence(durableExecution.id, {
          disposition: 'discarded_without_changes',
          evidence: { changedCount: inspected.evidence.changedCount }
        });
        sendExecutionEvent({ type: 'error', ...noChanges });
      } else {
        await updatePersistentJob(data.sessionId, job.id, {
          state: 'waiting_delivery',
          verification: execution.verification,
          isolationEvidence: inspected.evidence,
          workspaceHandleId: workspaceHandle.id,
          error: null
        });
        stateCenter.updateRun(durableExecution.id, {
          state: 'waiting_delivery',
          result: { verification: execution.verification, changes: execution.changes, isolationEvidence: inspected.evidence },
          error: null
        });
        sendExecutionEvent({
          type: 'delivery_gate',
          jobId: job.id,
          executionRunId: durableExecution.id,
          handleId: workspaceHandle.id,
          sourceRoot: workspaceHandle.sourceRoot,
          baseRevision: workspaceHandle.baseRevision,
          evidence: inspected.evidence,
          verification: execution.verification,
          message: '隔离实施和验证已经完成，等待你决定是否交付到正式工作区'
        });
      }
    }
  } catch (error) {
    if (durableExecution && stateCenter.getRun(durableExecution.id).state === 'cancelled') {
      let discarded = false;
      let discardError = null;
      if (workspaceHandle) { try { worktrees.discard(workspaceHandle.id); discarded = true; } catch (discardFailure) { discardError = discardFailure; } }
      try {
        await updatePersistentJob(data.sessionId, job.id, {
          state: discarded ? 'cancelled' : 'interrupted',
          workspaceHandleId: discarded ? null : workspaceHandle?.id,
          error: discarded
            ? { code: 'RUN_CANCELLED', message: '已由用户终止' }
            : { code: discardError?.code || 'WORKTREE_DISCARD_FAILED', message: '任务已停止，但隔离产物回收失败，请手动丢弃' }
        });
      } catch (_) {}
      if (discarded && stateCenter.getExecutionFence(durableExecution.id)) {
        stateCenter.settleExecutionFence(durableExecution.id, { disposition: 'discarded_after_cancel' });
      } else if (!discarded && workspaceHandle) {
        try {
          stateCenter.updateRun(durableExecution.id, {
            state: 'interrupted',
            error: { code: discardError?.code || 'WORKTREE_DISCARD_FAILED', message: '任务已停止，但隔离产物回收失败，请手动丢弃' }
          });
        } catch (_) {}
      }
      return;
    }
    if (workspaceHandle) {
      try { stateCenter.updateRun(durableExecution.id, { state: 'failed', error: { code: error.code || 'EXECUTION_FAILED', message: error.message } }); } catch (_) {}
    }
    // worktree 尚未准备成功时，方案仍保持待批准，用户修好 Git 状态后可以重试。
    if (workspaceHandle) await markJobFailed(data.sessionId, job.id, error);
    if (stream) stream.send({ type: 'error', message: asAppError(error).message });
    else throw error;
  } finally {
    activeControllers.delete(durableExecution.id);
    jobs.release(data.sessionId, runtimeJob.id);
    if (stream) stream.end();
  }
}

async function handleDeliveryDecision(req, res) {
  const data = validateDeliveryDecision(await parseJsonBody(req, config.MAX_BODY_BYTES));
  const session = store.getSession(data.sessionId);
  const job = session.job;
  if (!job?.workspaceHandleId || !job.executionRunId) throw new AppError(409, 'NO_ISOLATED_DELIVERY', '当前任务没有可处理的隔离产物');
  if (data.jobId !== job.id || data.executionRunId !== job.executionRunId || data.workspaceHandleId !== job.workspaceHandleId) {
    throw new AppError(409, 'DELIVERY_VERSION_CHANGED', '你确认的隔离产物已经变化，请刷新后重试');
  }
  if (data.action === 'deliver' && (data.expectedPatchHash !== job.isolationEvidence?.patchHash || data.expectedBaseRevision !== job.executionWorkspace?.baseRevision)) {
    throw new AppError(409, 'DELIVERY_EVIDENCE_CHANGED', '你确认的补丁指纹或基础版本已经变化');
  }
  const pendingHandle = stateCenter.getWorkspaceHandle(job.workspaceHandleId);
  if (pendingHandle.sessionId !== data.sessionId || pendingHandle.runId !== job.executionRunId) {
    throw new AppError(409, 'DELIVERY_OWNERSHIP_CHANGED', '隔离产物与当前任务不匹配');
  }
  if (data.action === 'deliver' && job.state !== 'waiting_delivery') {
    throw new AppError(409, 'DELIVERY_NOT_APPROVED', '只有已经通过验证的隔离产物可以交付');
  }
  if (data.action === 'discard' && !['waiting_delivery', 'needs_revision', 'failed', 'interrupted'].includes(job.state)) {
    throw new AppError(409, 'DELIVERY_NOT_DISCARDABLE', '当前隔离产物不能丢弃');
  }
  const handle = data.action === 'deliver'
    ? worktrees.deliver(job.workspaceHandleId, { patchHash: data.expectedPatchHash, baseRevision: data.expectedBaseRevision })
    : worktrees.discard(job.workspaceHandleId);
  const nextState = data.action === 'deliver' ? 'succeeded' : 'cancelled';
  await store.updateSession(data.sessionId, (current) => {
    if (!current.job || current.job.id !== job.id) throw new AppError(409, 'JOB_STATE_CHANGED', '任务状态已经变化');
    current.job = {
      ...current.job,
      state: nextState,
      delivery: { action: data.action, completedAt: new Date().toISOString(), sourceRoot: handle.sourceRoot },
      updatedAt: new Date().toISOString()
    };
    return current;
  });
  stateCenter.updateRun(job.executionRunId, {
    state: nextState,
    result: { ...(stateCenter.getRun(job.executionRunId).result || {}), delivery: { action: data.action, completedAt: new Date().toISOString() } },
    error: null
  });
  const executionFence = stateCenter.getExecutionFence(job.executionRunId);
  if (executionFence) {
    stateCenter.settleExecutionFence(job.executionRunId, {
      disposition: data.action === 'deliver' ? 'delivered' : 'discarded',
      evidence: { workspaceHandleId: handle.id, sourceRoot: handle.sourceRoot }
    });
  }
  runEvents.publish(job.executionRunId, data.action === 'deliver' ? 'delivery_completed' : 'delivery_discarded', {
    state: nextState,
    sourceRoot: handle.sourceRoot
  });
  if (data.action === 'deliver') {
    try {
      stateCenter.createContextNode({
        scope: handle.sourceRoot,
        type: 'lesson',
        title: `已交付产物：${session.name}`.slice(0, 160),
        content: JSON.stringify({
          planHash: job.planHash,
          verification: job.verification,
          isolationEvidence: job.isolationEvidence,
          deliveredAt: new Date().toISOString()
        }, null, 2).slice(0, 12_000),
        source: `run:${job.executionRunId}`,
        status: 'proposed',
        metadata: { requiresReview: true }
      });
    } catch (_) {}
  }
  sendJson(res, 200, { ok: true, state: nextState, action: data.action, sourceRoot: handle.sourceRoot });
}

async function handleCancel(req, res) {
  const data = validateCancelRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
  let cancelledRunId = null;
  await store.updateSession(data.sessionId, (session) => {
    if (jobs.isActive(data.sessionId)) throw new AppError(409, 'JOB_IN_PROGRESS', '任务正在运行，暂时不能取消');
    if (!session.job || session.job.state !== 'waiting_approval') {
      throw new AppError(409, 'NO_PENDING_APPROVAL', '当前没有等待确认的方案');
    }
    cancelledRunId = session.job.id;
    session.job = { ...session.job, state: 'cancelled', updatedAt: new Date().toISOString() };
    return session;
  });
  if (cancelledRunId) {
    try {
      stateCenter.updateRun(cancelledRunId, { state: 'cancelled', error: null });
      runEvents.publish(cancelledRunId, 'run_cancelled', { state: 'cancelled' });
    } catch (_) {}
  }
  sendJson(res, 200, { ok: true });
}

async function route(req, res) {
  const pathname = getPath(req);
  const requestUrl = new URL(req.url, 'http://localhost');
  req.on('error', () => { if (!res.writableEnded) res.end(); });

  if (!isTrustedHost(req)) return sendJson(res, 421, { error: { code: 'UNTRUSTED_HOST', message: '请求主机不受信任' } });

  if (pathname === '/' || pathname === '/index.html') return readStatic(res, 'index.html', 'text/html; charset=utf-8');
  if (pathname === '/marked.min.js') return readStatic(res, 'marked.min.js', 'application/javascript; charset=utf-8');
  if (pathname === '/purify.min.js') return readStatic(res, 'purify.min.js', 'application/javascript; charset=utf-8');
  if (pathname === '/healthz' && req.method === 'GET') {
    let stateHealth = null;
    let storage = null;
    try { stateHealth = stateCenter.health(); } catch (_) {}
    try { storage = storageManager.usage(); } catch (_) {}
    const providerRuntime = providers.providerRuntimeStatus();
    const degradedReasons = [];
    if (!stateHealth) degradedReasons.push('STATE_DATABASE_UNAVAILABLE');
    if (!storage?.lastMaintenance) degradedReasons.push('STORAGE_MAINTENANCE_NOT_COMPLETED');
    if (storage?.lastMaintenance?.status === 'failed') degradedReasons.push('STORAGE_MAINTENANCE_FAILED');
    if (storage?.warning) degradedReasons.push('STORAGE_WARNING');
    if (providerRuntime.shuttingDown || runtimeStatus.shuttingDown) degradedReasons.push('SHUTTING_DOWN');
    return sendJson(res, runtimeStatus.shuttingDown ? 503 : 200, {
      ok: !runtimeStatus.shuttingDown && Boolean(stateHealth),
      service: 'future-is-here',
      instanceId: runtimeIdentity,
      pid: process.pid,
      version: require('./package.json').version,
      startedAt: runtimeStatus.startedAt,
      degraded: degradedReasons.length > 0,
      degradedReasons,
      state: stateHealth,
      storage: storage ? { totalBytes: storage.totalBytes, warningBytes: storage.warningBytes, warning: storage.warning, lastMaintenance: storage.lastMaintenance } : null,
      providers: providerRuntime
    });
  }

  if (pathname.startsWith('/api/') && !isAllowedOrigin(req)) {
    return sendJson(res, 403, { error: { code: 'INVALID_ORIGIN', message: '请求来源不受信任' } });
  }

  if (pathname.startsWith('/api/') && !isAuthorized(req)) {
    return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '需要访问令牌' } });
  }

  if (pathname === '/api/health' && req.method === 'GET') return sendJson(res, 200, {
    ok: true,
    service: 'future-is-here',
    providerQueue: providers.getQueueStats(),
    durableState: stateCenter.health(),
    providerMetrics: providers.getMetrics(),
    storage: storageManager.usage()
  });

  if (pathname === '/api/sessions' && req.method === 'GET') return sendJson(res, 200, await store.listSessions());

  if (pathname === '/api/providers/health' && req.method === 'GET') {
    return sendJson(res, 200, await agentRegistry.inspect({ force: false }));
  }

  if (pathname === '/api/sessions' && req.method === 'POST') {
    const session = store.createSession(validateSessionCreate(await parseJsonBody(req, config.MAX_BODY_BYTES)));
    return sendJson(res, 201, session);
  }

  // 参考资料使用 4MB 二进制分块，避免把 100MB 文件转成 Base64 后复制进巨大 JSON。
  const referenceCollectionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reference-uploads$/);
  if (referenceCollectionMatch) {
    const sessionId = validateSessionId(decodeURIComponent(referenceCollectionMatch[1]));
    store.getSession(sessionId);
    if (req.method === 'GET') return sendJson(res, 200, { uploads: referenceLibrary.list(sessionId) });
    if (req.method === 'POST') {
      const manifest = await parseJsonBody(req, 1024 * 1024);
      return sendJson(res, 201, referenceLibrary.begin(sessionId, manifest));
    }
  }

  const referenceItemMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reference-uploads\/([^/]+)$/);
  if (referenceItemMatch && req.method === 'DELETE') {
    const sessionId = validateSessionId(decodeURIComponent(referenceItemMatch[1]));
    store.getSession(sessionId);
    return sendJson(res, 200, referenceLibrary.remove(sessionId, decodeURIComponent(referenceItemMatch[2])));
  }

  const referenceChunkMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reference-uploads\/([^/]+)\/files\/(\d+)$/);
  if (referenceChunkMatch && req.method === 'PUT') {
    const sessionId = validateSessionId(decodeURIComponent(referenceChunkMatch[1]));
    store.getSession(sessionId);
    const offset = Number(requestUrl.searchParams.get('offset'));
    const chunk = await parseBinaryBody(req, config.REFERENCE_CHUNK_BYTES);
    return sendJson(res, 200, referenceLibrary.appendChunk(
      sessionId,
      decodeURIComponent(referenceChunkMatch[2]),
      Number(referenceChunkMatch[3]),
      offset,
      chunk
    ));
  }

  const referenceCompleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reference-uploads\/([^/]+)\/complete$/);
  if (referenceCompleteMatch && req.method === 'POST') {
    const sessionId = validateSessionId(decodeURIComponent(referenceCompleteMatch[1]));
    store.getSession(sessionId);
    await parseJsonBody(req, 1_024);
    return sendJson(res, 200, referenceLibrary.complete(sessionId, decodeURIComponent(referenceCompleteMatch[2])));
  }

  const sessionCommandMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/commands$/);
  if (sessionCommandMatch && req.method === 'POST') {
    const sessionId = validateSessionId(decodeURIComponent(sessionCommandMatch[1]));
    const input = await parseJsonBody(req, 4 * 1024);
    return sendJson(res, 200, await conversationCommands.execute(sessionId, input));
  }

  // 历史轨迹查询：按运行分页回放仅追加事件，避免把不同轮次和成员过程混成一组。
  const sessionTracesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/traces$/);
  if (sessionTracesMatch && req.method === 'GET') {
    let decodedTraceSessionId;
    try {
      decodedTraceSessionId = decodeURIComponent(sessionTracesMatch[1]);
    } catch (_) {
      throw new AppError(400, 'INVALID_SESSION_ID', '无效的任务 ID');
    }
    const traceSessionId = validateSessionId(decodedTraceSessionId);
    store.getSession(traceSessionId);
    const beforeRunId = requestUrl.searchParams.get('beforeRunId') || null;
    const limit = Number.parseInt(requestUrl.searchParams.get('limit') || '8', 10);
    return sendJson(res, 200, listSessionTracePage(stateCenter, traceSessionId, { beforeRunId, limit }));
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    let decodedSessionId;
    try {
      decodedSessionId = decodeURIComponent(sessionMatch[1]);
    } catch (_) {
      throw new AppError(400, 'INVALID_SESSION_ID', '无效的任务 ID');
    }
    const sessionId = validateSessionId(decodedSessionId);
    if (req.method === 'GET') return sendJson(res, 200, store.getSession(sessionId));
    if (req.method === 'PATCH') {
      const data = validateSessionViewRequest(await parseJsonBody(req, config.MAX_BODY_BYTES));
      return sendJson(res, 200, await store.updateSession(sessionId, (session) => {
        session.lastMode = data.mode;
        return session;
      }));
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, await sessionPurger.purge(sessionId));
    }
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && req.method === 'GET') {
    const runId = decodeURIComponent(runMatch[1]);
    return sendJson(res, 200, publicRun(stateCenter.getRun(runId)));
  }

  const runEventsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (runEventsMatch && req.method === 'GET') {
    const runId = decodeURIComponent(runEventsMatch[1]);
    const after = Math.max(0, Number.parseInt(requestUrl.searchParams.get('after') || '0', 10) || 0);
    return streamRunEvents(req, res, runId, after);
  }

  if (pathname === '/api/context/nodes' && req.method === 'GET') {
    const scope = requestUrl.searchParams.get('scope') || null;
    const status = requestUrl.searchParams.get('status') || null;
    return sendJson(res, 200, { nodes: stateCenter.listContextNodes({ scope, status }) });
  }

  if (pathname === '/api/context/nodes' && req.method === 'POST') {
    const node = stateCenter.createContextNode(validateContextNodeCreate(await parseJsonBody(req, config.MAX_BODY_BYTES)));
    return sendJson(res, 201, node);
  }

  const contextDecisionMatch = pathname.match(/^\/api\/context\/nodes\/([^/]+)\/decision$/);
  if (contextDecisionMatch && req.method === 'POST') {
    const data = validateContextDecision(await parseJsonBody(req, config.MAX_BODY_BYTES));
    return sendJson(res, 200, stateCenter.decideContextNode(
      decodeURIComponent(contextDecisionMatch[1]),
      data.status,
      'user',
      data.expectedUpdatedAt
    ));
  }

  if (pathname === '/api/context/resolve' && req.method === 'GET') {
    const sessionId = validateSessionId(requestUrl.searchParams.get('sessionId') || '');
    const session = store.getSession(sessionId);
    const query = String(requestUrl.searchParams.get('query') || '').slice(0, config.MAX_TEXT_CHARS);
    return sendJson(res, 200, stateCenter.resolveContext({ workspacePath: session.workspace?.path || config.PROJECT_ROOT, query }));
  }

  if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
  const attachmentMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/);
  if (attachmentMatch && req.method === 'GET') {
    const sessionId = validateSessionId(decodeURIComponent(attachmentMatch[1]));
    const attachment = readAttachment(sessionId, decodeURIComponent(attachmentMatch[2]));
    setSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': attachment.mimeType, 'Cache-Control': 'private, max-age=3600' });
    return res.end(attachment.data);
  }
  if (pathname === '/api/workspaces' && req.method === 'GET') return sendJson(res, 200, { allowedRoots: allowedRoots() });
  if (pathname === '/api/workspace/command' && req.method === 'POST') return handleWorkspaceCommand(req, res);
  if (pathname === '/api/team/suggest' && req.method === 'POST') return handleTeamSuggestion(req, res);
  if (pathname === '/api/discuss' && req.method === 'POST') return handleDiscussion(req, res);
  if (pathname === '/api/discuss/import' && req.method === 'POST') return handleImportDiscussion(req, res);
  if (pathname === '/api/collaborate' && req.method === 'POST') return handleCollaboration(req, res);
  if (pathname === '/api/collaborate/execute' && req.method === 'POST') return handleExecute(req, res);
  if (pathname === '/api/collaborate/deliver' && req.method === 'POST') return handleDeliveryDecision(req, res);
  if (pathname === '/api/collaborate/cancel' && req.method === 'POST') return handleCancel(req, res);
  if (pathname === '/api/runs/cancel' && req.method === 'POST') return handleRunCancel(req, res);

  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
}

const server = http.createServer((req, res) => {
  const correlationId = crypto.randomUUID();
  res.setHeader('X-Correlation-ID', correlationId);
  route(req, res).catch((error) => {
    const appError = asAppError(error);
    logger.error('request_failed', { correlationId, code: appError.code, status: appError.status });
    if (!res.writableEnded) sendError(res, appError, correlationId);
  });
});

async function start() {
  runtimeStatus.startedAt = new Date().toISOString();
  runtimeStatus.shuttingDown = false;
  if (restoredSnapshot) logger.info('backup_restored', { snapshotId: restoredSnapshot.id });
  await store.recoverInterruptedJobs();
  stateCenter.recoverInterruptedWork();
  const deliveryRecovery = worktrees.reconcileDeliveries();
  for (const item of deliveryRecovery.filter((entry) => entry.disposition === 'delivered')) {
    const handle = item.handle;
    try {
      await store.updateSession(handle.sessionId, (session) => {
        if (session.job?.workspaceHandleId !== handle.id) return session;
        session.job = {
          ...session.job,
          state: 'succeeded',
          delivery: { action: 'deliver', completedAt: new Date().toISOString(), sourceRoot: handle.sourceRoot, recoveredAfterRestart: true },
          updatedAt: new Date().toISOString()
        };
        return session;
      });
      stateCenter.updateRun(handle.runId, {
        state: 'succeeded',
        result: { ...(stateCenter.getRun(handle.runId).result || {}), delivery: { action: 'deliver', recoveredAfterRestart: true } },
        error: null
      });
      const fence = stateCenter.getExecutionFence(handle.runId);
      if (fence?.state === 'armed') stateCenter.settleExecutionFence(handle.runId, { disposition: 'delivered_after_restart', evidence: { workspaceHandleId: handle.id } });
      runEvents.publish(handle.runId, 'delivery_reconciled', { state: 'succeeded', sourceRoot: handle.sourceRoot });
    } catch (error) {
      logger.error('delivery_reconcile_projection_failed', { handleId: handle.id, code: error.code || 'UNKNOWN' });
    }
  }
  if (deliveryRecovery.length) {
    logger.info('delivery_recovery', {
      checked: deliveryRecovery.length,
      delivered: deliveryRecovery.filter((item) => item.disposition === 'delivered').length,
      retrySafe: deliveryRecovery.filter((item) => item.disposition === 'retry_safe').length,
      manualReview: deliveryRecovery.filter((item) => item.disposition === 'manual_review').length
    });
  }
  const storageMaintenance = storageManager.maintain({ startup: true });
  stopStorageMaintenance = storageManager.start();
  logger.info('storage_maintenance', {
    reclaimedBytes: storageMaintenance.actions?.reclaimedBytes || 0,
    compactedSessionFiles: storageMaintenance.actions?.compactedSessionFiles || 0
  });
  for (const run of stateCenter.listRuns({ states: ['queued'], })) {
    if (run.kind === 'chat') continue;
    stateCenter.updateRun(run.id, {
      state: 'failed',
      error: { code: 'PROCESS_RESTARTED_RETRY_REQUIRED', message: '服务在长程协作中重启；已保留检查点和消息，请从任务页面重新发起' }
    });
  }
  chatRuntime.resumePending();
  const reconcile = await reconcileSessionJobs({ store, stateCenter });
  if (reconcile.mismatches.length > 0) {
    logger.warn('startup_reconcile_mismatch', { count: reconcile.mismatches.length });
  }
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(new AppError(500, 'SERVER_START_FAILED', `服务器无法监听 ${config.HOST}:${config.PORT}`, { cause: error }));
    };
    const onListening = () => {
      server.removeListener('error', onError);
      logger.info('server_started', { host: config.HOST, port: config.PORT, authRequired: Boolean(config.AUTH_TOKEN) });
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.PORT, config.HOST);
  });
  writeProcessIdentity();
}

function shutdown(signal = 'manual') {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    runtimeStatus.shuttingDown = true;
    logger.info('server_stopping', { signal, activeRuns: activeControllers.size });
    stopStorageMaintenance?.();
    for (const controller of activeControllers.values()) controller.abort();
    referenceLibrary.shutdown();
    providers.shutdownProviderProcesses();
    await new Promise((resolve) => {
      if (!server.listening) return resolve();
      const timer = setTimeout(() => {
        server.closeAllConnections?.();
        resolve();
      }, 5_000);
      timer.unref?.();
      server.close(() => { clearTimeout(timer); resolve(); });
    });
    try { stateCenter.checkpoint({ truncate: true }); } catch (_) {}
    try { stateCenter.close(); } catch (_) {}
    removeProcessIdentity();
    logger.info('server_stopped', { signal });
  })();
  return shutdownPromise;
}

if (require.main === module) {
  start().catch((error) => {
    runtimeStatus.lastStartupError = error.code || 'SERVER_START_FAILED';
    logger.error('server_start_failed', { code: error.code || 'SERVER_START_FAILED' });
    process.exitCode = 1;
  });
  process.once('SIGTERM', () => shutdown('SIGTERM').catch(() => { process.exitCode = 1; }));
  process.once('SIGINT', () => shutdown('SIGINT').catch(() => { process.exitCode = 1; }));
}

module.exports = { server, route, start, shutdown, MODES, isTrustedHost, isAllowedOrigin };
