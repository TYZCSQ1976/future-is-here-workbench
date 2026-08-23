const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { AppError } = require('./errors');
const { validateTeam } = require('./team');
const { validateSessionId } = require('./validation');

function createSessionStore(sessionsDir = config.SESSIONS_DIR) {
  const locks = new Map();

  function ensureDir() {
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(sessionsDir, 0o700);
  }

  function ensurePrivateFile(file) {
    if (process.platform !== 'win32' && fs.existsSync(file)) fs.chmodSync(file, 0o600);
  }

  function defaultWorkflow() {
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

  function sessionPath(id) {
    validateSessionId(id);
    return path.join(sessionsDir, `${id}.json`);
  }

  function normalizeSession(session) {
    if (!session || typeof session !== 'object' || Array.isArray(session) || !Array.isArray(session.messages)) {
      throw new AppError(500, 'SESSION_CORRUPTED', '任务数据已损坏');
    }
    if (typeof session.id !== 'string') throw new AppError(500, 'SESSION_CORRUPTED', '任务 ID 已损坏');
    validateSessionId(session.id);
    session.version = Number.isInteger(session.version) ? session.version : 1;
    session.archivedAt = session.archivedAt || null;
    session.lastMode = ['chat', 'discussion', 'collab'].includes(session.lastMode) ? session.lastMode : session.type;
    session.workspace = session.workspace && typeof session.workspace === 'object' ? session.workspace : null;
    if (session.messages.length > config.MAX_STORED_MESSAGES) {
      throw new AppError(500, 'SESSION_CORRUPTED', '任务消息数量超过安全上限');
    }
    if (session.team !== null && session.team !== undefined) {
      try { session.team = validateTeam(session.team); }
      catch (error) { throw new AppError(500, 'SESSION_CORRUPTED', '任务团队配置已损坏', { cause: error }); }
    } else {
      session.team = null;
    }
    session.discussionPlan = session.discussionPlan && typeof session.discussionPlan === 'object' ? session.discussionPlan : null;
    const workflow = session.workflow && typeof session.workflow === 'object' && !Array.isArray(session.workflow)
      ? session.workflow
      : {};
    session.workflow = {
      ...defaultWorkflow(),
      ...workflow,
      checkpoints: Array.isArray(workflow.checkpoints) ? workflow.checkpoints.slice(-config.MAX_WORKFLOW_CHECKPOINTS) : []
    };
    return session;
  }

  function readSession(id) {
    const file = sessionPath(id);
    if (!fs.existsSync(file)) throw new AppError(404, 'SESSION_NOT_FOUND', '任务不存在');
    try {
      ensurePrivateFile(file);
      return normalizeSession(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(500, 'SESSION_CORRUPTED', '任务数据无法读取', { cause: error });
    }
  }

  function atomicSave(session) {
    ensureDir();
    const normalized = normalizeSession(session);
    normalized.updatedAt = new Date().toISOString();
    normalized.version += 1;
    const file = sessionPath(normalized.id);
    const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    // 会话是用户历史的唯一完整副本：只去掉 JSON 排版空白，不删消息、不截断轨迹。
    fs.writeFileSync(temp, JSON.stringify(normalized), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
    ensurePrivateFile(file);
    return normalized;
  }

  function withLock(id, task) {
    const previous = locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    locks.set(id, current);
    return current.finally(() => {
      if (locks.get(id) === current) locks.delete(id);
    });
  }

  async function updateSession(id, mutator) {
    return withLock(id, async () => {
      const session = readSession(id);
      const next = await mutator(session);
      return atomicSave(next || session);
    });
  }

  function createSession(data) {
    ensureDir();
    const existingCount = fs.readdirSync(sessionsDir).filter((file) => /^\d{10,32}\.json$/.test(file)).length;
    if (existingCount >= config.MAX_SESSIONS) {
      throw new AppError(507, 'SESSION_CAPACITY_REACHED', '任务数量已达到容量上限，请先备份并清理旧任务');
    }
    let id;
    do {
      id = `${Date.now()}${String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')}`;
    } while (fs.existsSync(path.join(sessionsDir, `${id}.json`)));
    const now = new Date().toISOString();
    const session = {
      id,
      name: data.name,
      type: data.type,
      lastMode: data.type,
      collabMode: data.collabMode || null,
      team: null,
      workspace: null,
      discussionPlan: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
      archivedAt: null,
      job: null,
      workflow: defaultWorkflow(),
      messages: []
    };
    atomicSave(session);
    return readSession(id);
  }

  function appendMessage(id, message) {
    return updateSession(id, (session) => {
      if (session.messages.length >= config.MAX_STORED_MESSAGES) {
        throw new AppError(413, 'SESSION_TOO_LARGE', '这个任务的对话太长了，请新建任务继续');
      }
      session.messages.push(message);
      return session;
    });
  }

  function appendMessageOnce(id, message) {
    return updateSession(id, (session) => {
      if (message.id && session.messages.some((item) => item.id === message.id)) return session;
      if (session.messages.length >= config.MAX_STORED_MESSAGES) {
        throw new AppError(413, 'SESSION_TOO_LARGE', '这个任务的对话太长了，请新建任务继续');
      }
      session.messages.push(message);
      return session;
    });
  }

  function setJob(id, job) {
    return updateSession(id, (session) => {
      session.job = job;
      return session;
    });
  }

  function recordWorkflowCheckpoint(id, checkpoint) {
    return updateSession(id, (session) => {
      const now = new Date().toISOString();
      const item = {
        id: crypto.randomUUID(),
        phase: checkpoint.phase,
        round: Number.isInteger(checkpoint.round) ? checkpoint.round : session.workflow.round,
        agent: checkpoint.agent || null,
        artifactType: checkpoint.artifactType || null,
        summary: String(checkpoint.summary || '').slice(0, 2_000),
        createdAt: now
      };
      session.workflow = {
        ...session.workflow,
        objective: checkpoint.objective ?? session.workflow.objective,
        mode: checkpoint.mode ?? session.workflow.mode,
        phase: checkpoint.phase || session.workflow.phase,
        round: item.round || 0,
        promptVersion: checkpoint.promptVersion ?? session.workflow.promptVersion,
        reliability: checkpoint.reliability ?? session.workflow.reliability,
        acceptedPlan: checkpoint.acceptedPlan ?? session.workflow.acceptedPlan,
        checkpoints: [...session.workflow.checkpoints, item].slice(-config.MAX_WORKFLOW_CHECKPOINTS),
        updatedAt: now
      };
      return session;
    });
  }

  async function listSessions() {
    ensureDir();
    const files = fs.readdirSync(sessionsDir).filter((file) => /^\d{10,32}\.json$/.test(file));
    const sessions = [];
    for (const file of files) {
      try {
        const fullPath = path.join(sessionsDir, file);
        ensurePrivateFile(fullPath);
        const session = normalizeSession(JSON.parse(fs.readFileSync(fullPath, 'utf8')));
        if (session.archivedAt) continue;
        sessions.push({
          id: session.id,
          name: session.name,
          type: session.type,
          lastMode: session.lastMode,
          collabMode: session.collabMode,
          agentCount: Array.isArray(session.team?.agents) ? session.team.agents.length : 0,
          messageCount: session.messages.length,
          jobState: session.job ? session.job.state : null,
          workflowPhase: session.workflow.phase,
          reliability: session.workflow.reliability,
          workspacePath: session.workspace?.path || null,
          planReady: Boolean(session.discussionPlan),
          updatedAt: session.updatedAt
        });
      } catch (_) {
        // 列表接口跳过损坏文件，详情接口仍返回明确错误。
      }
    }
    return sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  async function archiveSession(id) {
    return updateSession(id, (session) => {
      session.archivedAt = new Date().toISOString();
      session.job = session.job ? { ...session.job, state: 'cancelled', updatedAt: new Date().toISOString() } : null;
      return session;
    });
  }

  async function deleteSession(id) {
    return withLock(id, async () => {
      const file = sessionPath(id);
      if (!fs.existsSync(file)) throw new AppError(404, 'SESSION_NOT_FOUND', '任务不存在');
      // 只删除已经通过 sessionPath 校验的单个任务文件，不碰 sessions 目录里的其他任务。
      fs.unlinkSync(file);
      return { id, deleted: true };
    });
  }

  async function recoverInterruptedJobs() {
    ensureDir();
    const files = fs.readdirSync(sessionsDir).filter((file) => /^\d{10,32}\.json$/.test(file));
    for (const file of files) {
      const id = file.slice(0, -5);
      try {
        ensurePrivateFile(path.join(sessionsDir, file));
        const session = readSession(id);
        if (session.job && ['running', 'executing', 'approved'].includes(session.job.state)) {
          await updateSession(id, (current) => {
            current.job = {
              ...current.job,
              state: 'interrupted',
              error: { code: 'PROCESS_RESTARTED', message: '服务重启时任务尚未完成，请重新发起' },
              updatedAt: new Date().toISOString()
            };
            return current;
          });
        }
      } catch (_) {}
    }
  }

  function compactStorage() {
    ensureDir();
    let files = 0;
    let bytesBefore = 0;
    let bytesAfter = 0;
    for (const name of fs.readdirSync(sessionsDir).filter((file) => /^\d{10,32}\.json$/.test(file))) {
      const file = path.join(sessionsDir, name);
      try {
        const original = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(original);
        // 在副本上校验，避免维护操作顺手补字段；落盘内容必须与原 JSON 语义完全一致。
        normalizeSession(JSON.parse(original));
        const compact = JSON.stringify(parsed);
        bytesBefore += Buffer.byteLength(original);
        bytesAfter += Buffer.byteLength(compact);
        if (compact.length >= original.length) continue;
        const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temp, compact, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temp, file);
        ensurePrivateFile(file);
        files += 1;
      } catch (_) {
        // 损坏文件交给详情接口报告，维护过程绝不覆盖它。
      }
    }
    return { files, bytesBefore, bytesAfter, reclaimedBytes: Math.max(0, bytesBefore - bytesAfter) };
  }

  return {
    ensureDir,
    getSession: readSession,
    updateSession,
    appendMessage,
    appendMessageOnce,
    setJob,
    recordWorkflowCheckpoint,
    createSession,
    listSessions,
    archiveSession,
    deleteSession,
    recoverInterruptedJobs,
    compactStorage
  };
}

const defaultStore = createSessionStore();
module.exports = { createSessionStore, ...defaultStore };
