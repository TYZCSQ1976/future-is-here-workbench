const config = require('./config');
const { AppError } = require('./errors');
const { validateTeam } = require('./team');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, field = '请求体') {
  if (!isPlainObject(value)) {
    throw new AppError(400, 'INVALID_OBJECT', `${field}必须是对象`);
  }
  return value;
}

function requireString(value, field, options = {}) {
  const { min = 1, max = config.MAX_TEXT_CHARS } = options;
  if (typeof value !== 'string') {
    throw new AppError(400, 'INVALID_STRING', `${field}必须是文本`);
  }
  const text = value.trim();
  if (text.length < min) throw new AppError(400, 'EMPTY_STRING', `${field}不能为空`);
  if (text.length > max) throw new AppError(413, 'TEXT_TOO_LARGE', `${field}太长了，请分成几次提交`);
  return text;
}

function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === '') return null;
  return requireString(value, field, options);
}

function validateAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AppError(400, 'INVALID_ATTACHMENTS', '图片附件必须是数组');
  if (value.length > config.MAX_IMAGES) throw new AppError(413, 'TOO_MANY_ATTACHMENTS', `一次最多添加 ${config.MAX_IMAGES} 张图片`);
  let totalBytes = 0;
  return value.map((item, index) => {
    if (!isPlainObject(item) || typeof item.data !== 'string') {
      throw new AppError(400, 'INVALID_ATTACHMENT', `第 ${index + 1} 个图片附件格式不正确`);
    }
    const match = item.data.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
    if (!match) throw new AppError(400, 'INVALID_ATTACHMENT_TYPE', '只支持 PNG、JPEG、WEBP 或 GIF 图片');
    const encoded = match[2].replace(/\s/g, '');
    let bytes;
    try { bytes = Buffer.from(encoded, 'base64'); } catch (_) { throw new AppError(400, 'INVALID_ATTACHMENT_DATA', '图片数据无法读取'); }
    if (!bytes.length || bytes.length > config.MAX_IMAGE_BYTES) {
      throw new AppError(413, 'ATTACHMENT_TOO_LARGE', `单张图片不能超过 ${Math.floor(config.MAX_IMAGE_BYTES / 1024 / 1024)}MB`);
    }
    totalBytes += bytes.length;
    if (totalBytes > config.MAX_TOTAL_IMAGE_BYTES) throw new AppError(413, 'ATTACHMENTS_TOO_LARGE', '本轮图片总大小不能超过 8MB');
    return {
      name: typeof item.name === 'string' ? item.name.trim().slice(0, 180) || `图片 ${index + 1}` : `图片 ${index + 1}`,
      mimeType: match[1].toLowerCase(),
      data: `data:${match[1].toLowerCase()};base64,${encoded}`
    };
  });
}

function validateMessage(value, attachments, folder = null) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text && !attachments.length && !folder) throw new AppError(400, 'EMPTY_MESSAGE', '消息不能为空，请输入文字或添加图片或文件夹');
  if (text.length > config.MAX_TEXT_CHARS) throw new AppError(413, 'TEXT_TOO_LARGE', '消息太长了，请分成几次提交');
  return text;
}

function validateWorkspaceImport(input) {
  const data = requireObject(input);
  if (!Array.isArray(data.files) || data.files.length === 0) throw new AppError(400, 'EMPTY_FOLDER', '请选择至少一个文件夹文件');
  if (data.files.length > 500) throw new AppError(413, 'FOLDER_TOO_LARGE', '一次最多添加 500 个文件');
  let totalBytes = 0;
  const files = data.files.map((item, index) => {
    if (!isPlainObject(item) || typeof item.path !== 'string' || typeof item.data !== 'string') throw new AppError(400, 'INVALID_FOLDER_FILE', `第 ${index + 1} 个文件格式不正确`);
    const relativePath = item.path.replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('/') || relativePath.split('/').includes('..') || relativePath.includes('\0')) throw new AppError(400, 'INVALID_FOLDER_PATH', '文件夹中包含无效路径');
    const encoded = item.data.replace(/^data:[^;]+;base64,/, '').replace(/\s/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    totalBytes += bytes.length;
    if (totalBytes > 6 * 1024 * 1024) throw new AppError(413, 'FOLDER_TOO_LARGE', '添加的文件夹不能超过 6MB');
    return { path: relativePath, data: encoded, bytes: bytes.length };
  });
  return { name: optionalString(data.name, '文件夹名称', { max: 120 }) || files[0].path.split('/')[0], files };
}

function validateReferenceFolder(input) {
  const data = requireObject(input);
  if (data.uploadId !== undefined) {
    const uploadId = requireString(data.uploadId, '资料上传编号', { max: 36 });
    if (!/^[0-9a-f-]{36}$/i.test(uploadId)) throw new AppError(400, 'INVALID_REFERENCE_UPLOAD_ID', '资料上传编号无效');
    return {
      uploadId,
      name: optionalString(data.name, '资料名称', { max: 120 }) || '参考资料'
    };
  }
  // 兼容旧页面：小资料仍可用原 JSON 结构；新版页面一律走二进制分块上传。
  return validateWorkspaceImport(data);
}

function validateSessionId(value) {
  if (typeof value !== 'string' || !/^\d{10,32}$/.test(value)) {
    throw new AppError(400, 'INVALID_SESSION_ID', '无效的任务 ID');
  }
  return value;
}

function validateSessionCreate(input) {
  const data = requireObject(input);
  const type = ['chat', 'discussion', 'collab'].includes(data.type) ? data.type : data.type === undefined ? 'chat' : null;
  if (!type) throw new AppError(400, 'INVALID_SESSION_TYPE', '无效的任务类型');
  const collabMode = data.collabMode === null || data.collabMode === undefined
    ? null
    : validateCollabMode(data.collabMode);
  return {
    name: optionalString(data.name, '任务名称', { max: config.MAX_NAME_CHARS }) || '新任务',
    type,
    collabMode
  };
}

function validateAgent(value) {
  // 'all' 表示同时调用所有已注册 Provider（当前为 Claude + Codex + dsh）。
  if (!['claude', 'codex', 'dsh', 'all'].includes(value)) {
    throw new AppError(400, 'INVALID_AGENT', '无效的 AI 对象');
  }
  return value;
}

function validateChatAgents(value, legacyAgent) {
  if (value === undefined) {
    const agent = validateAgent(legacyAgent);
    return agent === 'all' ? [...config.PROVIDER_KEYS] : [agent];
  }
  if (!Array.isArray(value)) throw new AppError(400, 'INVALID_AGENTS', 'AI 对象名单必须是数组');
  if (value.length === 0) throw new AppError(400, 'EMPTY_AGENTS', '至少选择一个 AI 对象');
  if (value.length > config.PROVIDER_KEYS.length) throw new AppError(400, 'TOO_MANY_AGENTS', '选择的 AI 对象过多');
  const agents = value.map((agent) => validateAgent(agent));
  if (agents.includes('all')) throw new AppError(400, 'INVALID_AGENTS', '具体名单中不能使用“全部”');
  if (new Set(agents).size !== agents.length) throw new AppError(400, 'DUPLICATE_AGENTS', 'AI 对象不能重复选择');
  return agents;
}

function validateChatRequest(input) {
  const data = requireObject(input);
  const agents = validateChatAgents(data.agents, data.agent);
  // agent 仅为旧版任务和客户端保留；实际调度始终使用明确的 agents 名单。
  const agent = agents.length === 1 ? agents[0] : 'all';
  const coordination = data.coordination === undefined
    ? (agents.length >= 2 ? 'cross_check' : 'independent')
    : ['independent', 'cross_check'].includes(data.coordination) ? data.coordination : null;
  if (!coordination) throw new AppError(400, 'INVALID_CHAT_COORDINATION', '无效的双 AI 方式');
  if (agents.length < 2 && coordination === 'cross_check') {
    throw new AppError(400, 'CHAT_COORDINATION_REQUIRES_TEAM', '互相确认只适用于双 AI');
  }
  const attachments = validateAttachments(data.attachments);
  const folder = data.folder === undefined || data.folder === null ? null : validateReferenceFolder(data.folder);
  return {
    sessionId: validateSessionId(data.sessionId),
    message: validateMessage(data.message, attachments, folder),
    attachments,
    folder,
    agents,
    agent,
    coordination,
    requestId: data.requestId === undefined ? null : requireString(data.requestId, '请求编号', { max: 120 })
  };
}

function validateContextNodeCreate(input) {
  const data = requireObject(input);
  const allowedTypes = ['goal', 'product', 'architecture', 'decision', 'constraint', 'operation', 'lesson'];
  if (!allowedTypes.includes(data.type)) throw new AppError(400, 'INVALID_CONTEXT_TYPE', '无效的上下文节点类型');
  const metadata = isPlainObject(data.metadata) ? data.metadata : {};
  const expiresAt = metadata.expiresAt === undefined || metadata.expiresAt === null || metadata.expiresAt === ''
    ? null
    : requireString(metadata.expiresAt, '记忆过期时间', { max: 40 });
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) throw new AppError(400, 'INVALID_CONTEXT_EXPIRY', '记忆过期时间格式无效');
  const supersedesId = metadata.supersedesId === undefined || metadata.supersedesId === null || metadata.supersedesId === ''
    ? null
    : requireString(metadata.supersedesId, '被替代节点', { max: 80 });
  return {
    scope: requireString(data.scope, '适用范围', { max: 2_000 }),
    type: data.type,
    title: requireString(data.title, '节点标题', { max: 160 }),
    content: requireString(data.content, '节点内容', { max: 12_000 }),
    source: optionalString(data.source, '节点来源', { max: 500 }) || 'user',
    status: data.approve === true ? 'approved' : 'proposed',
    metadata: { expiresAt, supersedesId }
  };
}

function validateContextDecision(input) {
  const data = requireObject(input);
  if (!['approved', 'rejected', 'superseded'].includes(data.status)) {
    throw new AppError(400, 'INVALID_CONTEXT_DECISION', '无效的上下文节点决定');
  }
  return {
    status: data.status,
    expectedUpdatedAt: requireString(data.expectedUpdatedAt, '节点版本', { max: 80 })
  };
}

function validateDeliveryDecision(input) {
  const data = requireObject(input);
  if (!['deliver', 'discard'].includes(data.action)) {
    throw new AppError(400, 'INVALID_DELIVERY_ACTION', '交付操作必须是 deliver 或 discard');
  }
  const action = data.action;
  return {
    sessionId: validateSessionId(data.sessionId),
    action,
    jobId: requireString(data.jobId, '任务版本', { max: 120 }),
    executionRunId: requireString(data.executionRunId, '执行运行编号', { max: 120 }),
    workspaceHandleId: requireString(data.workspaceHandleId, '隔离产物编号', { max: 120 }),
    expectedPatchHash: action === 'deliver'
      ? requireString(data.expectedPatchHash, '补丁指纹', { min: 64, max: 64 })
      : optionalString(data.expectedPatchHash, '补丁指纹', { min: 64, max: 64 }),
    expectedBaseRevision: action === 'deliver'
      ? requireString(data.expectedBaseRevision, '基础版本', { max: 120 })
      : optionalString(data.expectedBaseRevision, '基础版本', { max: 120 })
  };
}

function validateCollabMode(value) {
  if (!config.COLLAB_MODE_KEYS.includes(value)) {
    throw new AppError(400, 'INVALID_COLLAB_MODE', '无效的协作模式');
  }
  return value;
}

function validateCollabRequest(input) {
  const data = requireObject(input);
  const gateMode = data.gateMode === 'auto' ? 'auto' : data.gateMode === 'manual' || data.gateMode === undefined ? 'manual' : null;
  if (!gateMode) throw new AppError(400, 'INVALID_GATE_MODE', '无效的闸门模式');
  if (gateMode === 'auto' && !config.ALLOW_AUTO_GATE) {
    throw new AppError(403, 'AUTO_GATE_DISABLED', '为保证可靠性，当前必须由你确认方案后才能执行');
  }
  const attachments = validateAttachments(data.attachments);
  const folder = data.folder === undefined || data.folder === null ? null : validateReferenceFolder(data.folder);
  return {
    sessionId: validateSessionId(data.sessionId),
    goal: validateMessage(data.goal, attachments, folder),
    mode: validateCollabMode(data.mode),
    gateMode,
    team: validateTeam(data.team),
    attachments,
    folder
  };
}

function validateTeamSuggestRequest(input) {
  const data = requireObject(input);
  const plannerProvider = validateAgent(data.plannerProvider);
  if (plannerProvider === 'all') throw new AppError(400, 'INVALID_AGENT', '组队建议一次只能选择一个 AI');
  const desiredCount = Number(data.desiredCount);
  if (!Number.isInteger(desiredCount) || desiredCount < 2 || desiredCount > config.MAX_TEAM_SIZE) {
    throw new AppError(400, 'INVALID_TEAM_SIZE', `建议团队人数必须在 2 到 ${config.MAX_TEAM_SIZE} 之间`);
  }
  return {
    goal: requireString(data.goal, '任务目标'),
    mode: validateCollabMode(data.mode),
    plannerProvider,
    desiredCount
  };
}

function validateExecuteRequest(input) {
  const data = requireObject(input);
  return {
    sessionId: validateSessionId(data.sessionId),
    // 方案由服务端保存；兼容旧版前端传回的完整方案，但仍受输出上限约束。
    plan: optionalString(data.plan, '方案', { max: config.MAX_PROVIDER_OUTPUT_CHARS }),
    expectedJobId: requireString(data.expectedJobId, '方案任务编号', { max: 120 }),
    expectedPlanHash: requireString(data.expectedPlanHash, '方案指纹', { min: 64, max: 64 }),
    expectedContextDigest: requireString(data.expectedContextDigest, '上下文指纹', { min: 64, max: 64 }),
    expectedDeterministicVerificationPlanHash: optionalString(data.expectedDeterministicVerificationPlanHash, '系统检查计划指纹', { min: 64, max: 64 }),
    acknowledgeDisagreement: data.acknowledgeDisagreement === true
  };
}

function validateCancelRequest(input) {
  const data = requireObject(input);
  return { sessionId: validateSessionId(data.sessionId) };
}

function validateRunCancelRequest(input) {
  const data = requireObject(input);
  return { sessionId: validateSessionId(data.sessionId), runId: requireString(data.runId, '运行编号', { max: 120 }) };
}

function validateSessionViewRequest(input) {
  const data = requireObject(input);
  if (!['chat', 'discussion', 'collab'].includes(data.mode)) {
    throw new AppError(400, 'INVALID_SESSION_VIEW', '无效的任务工作模式');
  }
  return { mode: data.mode };
}

function validateWorkspaceCommandRequest(input) {
  const data = requireObject(input);
  return {
    sessionId: validateSessionId(data.sessionId),
    command: requireString(data.command, '工作区命令', { max: 4_000 })
  };
}

function validateImportDiscussionRequest(input) {
  const data = requireObject(input);
  return { sourceSessionId: validateSessionId(data.sourceSessionId) };
}

module.exports = {
  isPlainObject,
  requireObject,
  requireString,
  validateSessionId,
  validateSessionCreate,
  validateChatRequest,
  validateCollabRequest,
  validateTeamSuggestRequest,
  validateExecuteRequest,
  validateCancelRequest,
  validateRunCancelRequest,
  validateSessionViewRequest,
  validateWorkspaceCommandRequest,
  validateWorkspaceImport,
  validateReferenceFolder,
  validateImportDiscussionRequest,
  validateContextNodeCreate,
  validateContextDecision,
  validateDeliveryDecision
};
