const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const config = require('./config');
const { AppError } = require('./errors');

const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'interrupted']);
const TERMINAL_RUN_STATES = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'dead_letter']);

function asJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const text = String(value);
    if (!text.startsWith('gz:')) return JSON.parse(text);
    const decoded = zlib.gunzipSync(Buffer.from(text.slice(3), 'base64'), {
      maxOutputLength: config.MAX_STATE_RECORD_BYTES
    }).toString('utf8');
    return JSON.parse(decoded);
  } catch (_) { return fallback; }
}

function stringify(value) {
  const json = JSON.stringify(value === undefined ? null : value);
  const bytes = Buffer.byteLength(json);
  if (bytes < config.STATE_JSON_COMPRESSION_THRESHOLD_BYTES || bytes > config.MAX_STATE_RECORD_BYTES) return json;
  const compressed = `gz:${zlib.gzipSync(Buffer.from(json)).toString('base64')}`;
  return Buffer.byteLength(compressed) < bytes * 0.85 ? compressed : json;
}

function nowIso() {
  return new Date().toISOString();
}

function tokenize(value) {
  const text = String(value || '').toLowerCase();
  const tokens = new Set(text.match(/[a-z0-9_-]{2,}/g) || []);
  for (const group of text.match(/[\p{Script=Han}]+/gu) || []) {
    if (group.length === 1) tokens.add(group);
    for (let index = 0; index < group.length - 1; index += 1) tokens.add(group.slice(index, index + 2));
  }
  return tokens;
}

function createStateCenter(databasePath = config.STATE_DB_PATH) {
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);

  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = FULL;
    PRAGMA wal_autocheckpoint = 256;
    PRAGMA journal_size_limit = 1048576;
  `);
  migrate(database);
  if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);

  function transaction(task) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const value = task();
      database.exec('COMMIT');
      return value;
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch (_) {}
      throw error;
    }
  }

  function rowToRun(row) {
    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.session_id,
      kind: row.kind,
      state: row.state,
      idempotencyKey: row.idempotency_key,
      input: asJson(row.input_json, {}),
      result: asJson(row.result_json, null),
      error: asJson(row.error_json, null),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at
    };
  }

  function rowToDelivery(row) {
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      recipientId: row.recipient_id,
      phase: row.phase,
      dedupeKey: row.dedupe_key,
      state: row.state,
      payload: asJson(row.payload_json, {}),
      result: asJson(row.result_json, null),
      attemptCount: row.attempt_count,
      maxAttempts: row.max_attempts,
      leaseOwner: row.lease_owner,
      leaseUntil: row.lease_until,
      lastError: asJson(row.last_error_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      acknowledgedAt: row.acknowledged_at
    };
  }

  function rowToExecutionFence(row) {
    if (!row) return null;
    return {
      runId: row.run_id,
      sessionId: row.session_id,
      jobId: row.job_id,
      planHash: row.plan_hash,
      contextDigest: row.context_digest,
      workspaceHandleId: row.workspace_handle_id,
      provider: row.provider,
      state: row.state,
      settlement: asJson(row.settlement_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      settledAt: row.settled_at
    };
  }

  function rowToMessage(row) {
    if (!row) return null;
    return {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      senderId: row.sender_id,
      recipientId: row.recipient_id,
      phase: row.phase,
      kind: row.kind,
      text: row.text,
      metadata: asJson(row.metadata_json, {}),
      createdAt: row.created_at
    };
  }

  function appendEventInside(runId, type, payload) {
    const sequence = database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM run_events WHERE run_id = ?').get(runId).next;
    const createdAt = nowIso();
    database.prepare('INSERT INTO run_events (run_id, sequence, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, sequence, type, stringify(payload || {}), createdAt);
    if (sequence > config.MAX_RUN_EVENTS) {
      database.prepare('DELETE FROM run_events WHERE run_id = ? AND sequence <= ?').run(runId, sequence - config.MAX_RUN_EVENTS);
    }
    return { runId, sequence, type, payload: payload || {}, createdAt };
  }

  function createRun({ id = crypto.randomUUID(), sessionId, kind, idempotencyKey, input = {}, agents = [] }) {
    if (!sessionId || !kind || !idempotencyKey) throw new AppError(400, 'INVALID_RUN', '运行缺少任务、类型或防重复编号');
    return transaction(() => {
      const existing = database.prepare('SELECT * FROM runs WHERE session_id = ? AND idempotency_key = ?').get(sessionId, idempotencyKey);
      if (existing) return { created: false, run: rowToRun(existing) };
      const now = nowIso();
      database.prepare(`
        INSERT INTO runs (id, session_id, kind, state, idempotency_key, input_json, result_json, error_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?, NULL, NULL, 1, ?, ?)
      `).run(id, sessionId, kind, idempotencyKey, stringify(input), now, now);
      const insertAgent = database.prepare(`
        INSERT INTO run_agents (run_id, agent_id, provider, name, role, focus, capabilities_json, prompt_version, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      `);
      for (const agent of agents) {
        insertAgent.run(id, agent.id, agent.provider, agent.name || agent.id, agent.role || '', agent.focus || '', stringify(agent.capabilities || {}), agent.promptVersion || null, now, now);
      }
      return { created: true, run: rowToRun(database.prepare('SELECT * FROM runs WHERE id = ?').get(id)) };
    });
  }

  function getRun(runId) {
    const run = rowToRun(database.prepare('SELECT * FROM runs WHERE id = ?').get(runId));
    if (!run) throw new AppError(404, 'RUN_NOT_FOUND', '运行不存在');
    return run;
  }

  function findRunByRequest(sessionId, idempotencyKey) {
    return rowToRun(database.prepare('SELECT * FROM runs WHERE session_id = ? AND idempotency_key = ?').get(sessionId, idempotencyKey));
  }

  function listRuns({ states = null, kind = null, sessionId = null } = {}) {
    const clauses = [];
    const params = [];
    if (Array.isArray(states) && states.length) {
      clauses.push(`state IN (${states.map(() => '?').join(',')})`);
      params.push(...states);
    }
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    if (sessionId) { clauses.push('session_id = ?'); params.push(sessionId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return database.prepare(`SELECT * FROM runs ${where} ORDER BY created_at ASC`).all(...params).map(rowToRun);
  }

  function updateRun(runId, { expectedStates = null, state, result, error, event = null } = {}) {
    return transaction(() => {
      const current = getRun(runId);
      if (expectedStates && !expectedStates.includes(current.state)) {
        throw new AppError(409, 'RUN_STATE_CHANGED', '运行状态已经发生变化');
      }
      const nextState = state || current.state;
      const now = nowIso();
      const startedAt = nextState === 'running' && !current.startedAt ? now : current.startedAt;
      const completedAt = TERMINAL_RUN_STATES.has(nextState) ? now : null;
      database.prepare(`
        UPDATE runs SET state = ?, result_json = ?, error_json = ?, revision = revision + 1,
          updated_at = ?, started_at = ?, completed_at = ? WHERE id = ?
      `).run(
        nextState,
        result === undefined ? stringify(current.result) : stringify(result),
        error === undefined ? stringify(current.error) : stringify(error),
        now, startedAt, completedAt, runId
      );
      const persistedEvent = event ? appendEventInside(runId, event.type, event.payload) : null;
      return { run: getRun(runId), event: persistedEvent };
    });
  }

  function appendEvent(runId, type, payload = {}) {
    getRun(runId);
    return transaction(() => appendEventInside(runId, type, payload));
  }

  function listEvents(runId, afterSequence = 0, limit = config.MAX_RUN_EVENTS) {
    const safeAfter = Number.isInteger(Number(afterSequence)) ? Math.max(0, Number(afterSequence)) : 0;
    const safeLimit = Math.min(config.MAX_RUN_EVENTS, Math.max(1, Number(limit) || config.MAX_RUN_EVENTS));
    const boundary = database.prepare(`
      SELECT MIN(sequence) AS first_available, MIN(created_at) AS first_available_at
      FROM run_events WHERE run_id = ?
    `).get(runId);
    const firstAvailable = Number(boundary?.first_available || 0);
    const hasTruncatedHistory = firstAvailable > 1 && safeAfter < firstAvailable - 1;
    const rows = database.prepare(`
      SELECT run_id, sequence, type, payload_json, created_at FROM run_events
      WHERE run_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(runId, Math.max(safeAfter, hasTruncatedHistory ? firstAvailable - 1 : safeAfter), hasTruncatedHistory ? Math.max(0, safeLimit - 1) : safeLimit).map((row) => ({
      runId: row.run_id,
      sequence: row.sequence,
      type: row.type,
      payload: asJson(row.payload_json, {}),
      createdAt: row.created_at
    }));
    if (hasTruncatedHistory) {
      rows.unshift({
        runId,
        sequence: firstAvailable - 1,
        type: 'trajectory_truncated',
        payload: {
          droppedFromSequence: safeAfter + 1,
          droppedThroughSequence: firstAvailable - 1,
          droppedCount: firstAvailable - safeAfter - 1,
          reason: 'RUN_EVENT_RETENTION_LIMIT',
          message: '更早的高频轨迹已按保留上限清理；审批、结果和当前可用事件仍按原序列展示'
        },
        createdAt: boundary.first_available_at
      });
    }
    return rows;
  }

  function latestSequence(runId) {
    return database.prepare('SELECT COALESCE(MAX(sequence), 0) AS latest FROM run_events WHERE run_id = ?').get(runId).latest;
  }

  function enqueueDelivery({ id = crypto.randomUUID(), runId, recipientId, phase, dedupeKey, payload = {}, maxAttempts = config.MAX_DELIVERY_ATTEMPTS }) {
    if (!runId || !recipientId || !phase || !dedupeKey) throw new AppError(400, 'INVALID_DELIVERY', '投递信息不完整');
    return transaction(() => {
      const existing = database.prepare('SELECT * FROM deliveries WHERE run_id = ? AND dedupe_key = ?').get(runId, dedupeKey);
      if (existing) return rowToDelivery(existing);
      const now = nowIso();
      database.prepare(`
        INSERT INTO deliveries (id, run_id, recipient_id, phase, dedupe_key, state, payload_json, result_json,
          attempt_count, max_attempts, lease_owner, lease_until, last_error_json, created_at, updated_at, acknowledged_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, 0, ?, NULL, NULL, NULL, ?, ?, NULL)
      `).run(id, runId, recipientId, phase, dedupeKey, stringify(payload), maxAttempts, now, now);
      return rowToDelivery(database.prepare('SELECT * FROM deliveries WHERE id = ?').get(id));
    });
  }

  function getDelivery(deliveryId) {
    const delivery = rowToDelivery(database.prepare('SELECT * FROM deliveries WHERE id = ?').get(deliveryId));
    if (!delivery) throw new AppError(404, 'DELIVERY_NOT_FOUND', '投递不存在');
    return delivery;
  }

  function listDeliveries(runId, phase = null) {
    const rows = phase
      ? database.prepare('SELECT * FROM deliveries WHERE run_id = ? AND phase = ? ORDER BY created_at ASC').all(runId, phase)
      : database.prepare('SELECT * FROM deliveries WHERE run_id = ? ORDER BY created_at ASC').all(runId);
    return rows.map(rowToDelivery);
  }

  function claimDelivery(deliveryId, workerId, leaseMs = config.DELIVERY_LEASE_MS) {
    return transaction(() => {
      const current = getDelivery(deliveryId);
      const now = Date.now();
      const leaseExpired = current.state === 'leased' && Date.parse(current.leaseUntil || '') <= now;
      if (!['pending', 'interrupted'].includes(current.state) && !leaseExpired) return null;
      if (current.attemptCount >= current.maxAttempts) return null;
      const updatedAt = nowIso();
      const leaseUntil = new Date(now + leaseMs).toISOString();
      database.prepare(`
        UPDATE deliveries SET state = 'leased', attempt_count = attempt_count + 1, lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(workerId, leaseUntil, updatedAt, deliveryId);
      return getDelivery(deliveryId);
    });
  }

  function acknowledgeDelivery(deliveryId, result = {}) {
    return transaction(() => {
      const current = getDelivery(deliveryId);
      if (current.state === 'acked') return current;
      if (current.state !== 'leased') throw new AppError(409, 'DELIVERY_NOT_LEASED', '投递尚未被成员领取');
      const now = nowIso();
      database.prepare(`
        UPDATE deliveries SET state = 'acked', result_json = ?, lease_owner = NULL, lease_until = NULL,
          last_error_json = NULL, updated_at = ?, acknowledged_at = ? WHERE id = ?
      `).run(stringify(result), now, now, deliveryId);
      return getDelivery(deliveryId);
    });
  }

  function failDelivery(deliveryId, error, retryable = false) {
    return transaction(() => {
      const current = getDelivery(deliveryId);
      if (current.state !== 'leased') return current;
      const canRetry = retryable && current.attemptCount < current.maxAttempts;
      const nextState = canRetry ? 'pending' : 'dead_letter';
      database.prepare(`
        UPDATE deliveries SET state = ?, lease_owner = NULL, lease_until = NULL, last_error_json = ?, updated_at = ? WHERE id = ?
      `).run(nextState, stringify(error || {}), nowIso(), deliveryId);
      return getDelivery(deliveryId);
    });
  }

  function recordMessage({ id = crypto.randomUUID(), runId, sessionId, senderId, recipientId = null, phase, kind = 'agent', text, metadata = {} }) {
    return transaction(() => {
      const existing = database.prepare('SELECT * FROM messages WHERE run_id = ? AND sender_id = ? AND phase = ?').get(runId, senderId, phase);
      if (existing) return rowToMessage(existing);
      database.prepare(`
        INSERT INTO messages (id, run_id, session_id, sender_id, recipient_id, phase, kind, text, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, runId, sessionId, senderId, recipientId, phase, kind, text, stringify(metadata), nowIso());
      return rowToMessage(database.prepare('SELECT * FROM messages WHERE id = ?').get(id));
    });
  }

  function findMessage(runId, senderId, phase) {
    return rowToMessage(database.prepare('SELECT * FROM messages WHERE run_id = ? AND sender_id = ? AND phase = ?').get(runId, senderId, phase));
  }

  function listMessages(runId) {
    return database.prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY created_at ASC, id ASC').all(runId).map(rowToMessage);
  }

  function listRunAgents(runId) {
    return database.prepare('SELECT * FROM run_agents WHERE run_id = ? ORDER BY rowid ASC').all(runId).map((row) => ({
      id: row.agent_id,
      provider: row.provider,
      name: row.name,
      role: row.role,
      focus: row.focus,
      capabilities: asJson(row.capabilities_json, {}),
      promptVersion: row.prompt_version,
      status: row.status
    }));
  }

  function setAgentStatus(runId, agentId, status) {
    database.prepare('UPDATE run_agents SET status = ?, updated_at = ? WHERE run_id = ? AND agent_id = ?').run(status, nowIso(), runId, agentId);
  }

  // 可写 Provider 一旦被放行，本次执行就不能在进程重启后自动重放。
  // 栅栏与运行、审批指纹和隔离工作区绑定，直到产物被交付或丢弃才结清。
  function armExecutionFence({ runId, sessionId, jobId, planHash, contextDigest, workspaceHandleId, provider }) {
    if (![runId, sessionId, jobId, planHash, contextDigest, workspaceHandleId, provider].every((value) => typeof value === 'string' && value.trim())) {
      throw new AppError(400, 'INVALID_EXECUTION_FENCE', '执行防重放信息不完整');
    }
    return transaction(() => {
      const run = getRun(runId);
      if (run.kind !== 'execution' || run.sessionId !== sessionId || run.state !== 'running') {
        throw new AppError(409, 'EXECUTION_FENCE_OWNERSHIP_CHANGED', '执行运行的状态或归属已经变化');
      }
      if (run.input.approvedJobId !== jobId || run.input.approvedPlanHash !== planHash || run.input.contextDigest !== contextDigest) {
        throw new AppError(409, 'EXECUTION_FENCE_APPROVAL_CHANGED', '执行栅栏与已批准的方案版本不一致');
      }
      const handle = getWorkspaceHandle(workspaceHandleId);
      if (handle.runId !== runId || handle.sessionId !== sessionId || handle.state !== 'prepared') {
        throw new AppError(409, 'EXECUTION_FENCE_OWNERSHIP_CHANGED', '隔离工作区的状态或归属已经变化');
      }
      if (!listRunAgents(runId).some((agent) => agent.provider === provider && agent.id === handle.agentId)) {
        throw new AppError(409, 'EXECUTION_FENCE_PROVIDER_CHANGED', '执行者身份与隔离工作区不一致');
      }
      const existing = database.prepare('SELECT * FROM execution_fences WHERE run_id = ?').get(runId);
      if (existing) {
        throw new AppError(409, 'EXECUTION_REPLAY_BLOCKED', '这次执行已经进入过可写阶段，系统拒绝重复调用 Provider');
      }
      const now = nowIso();
      database.prepare(`
        INSERT INTO execution_fences (
          run_id, session_id, job_id, plan_hash, context_digest, workspace_handle_id,
          provider, state, settlement_json, created_at, updated_at, settled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'armed', NULL, ?, ?, NULL)
      `).run(runId, sessionId, jobId, planHash, contextDigest, workspaceHandleId, provider, now, now);
      appendEventInside(runId, 'execution_fence_armed', {
        jobId, workspaceHandleId, provider,
        message: '已进入可写执行阶段；服务重启后不会自动重放'
      });
      return rowToExecutionFence(database.prepare('SELECT * FROM execution_fences WHERE run_id = ?').get(runId));
    });
  }

  function getExecutionFence(runId) {
    return rowToExecutionFence(database.prepare('SELECT * FROM execution_fences WHERE run_id = ?').get(runId));
  }

  function settleExecutionFence(runId, { disposition, evidence = {} } = {}) {
    if (typeof disposition !== 'string' || !disposition.trim()) {
      throw new AppError(400, 'INVALID_EXECUTION_FENCE_SETTLEMENT', '执行防重放栅栏缺少结清方式');
    }
    return transaction(() => {
      const current = getExecutionFence(runId);
      if (!current) throw new AppError(404, 'EXECUTION_FENCE_NOT_FOUND', '执行防重放栅栏不存在');
      if (current.state === 'settled') return current;
      const now = nowIso();
      const settlement = { disposition, evidence, settledAt: now };
      database.prepare(`
        UPDATE execution_fences
        SET state = 'settled', settlement_json = ?, updated_at = ?, settled_at = ?
        WHERE run_id = ? AND state = 'armed'
      `).run(stringify(settlement), now, now, runId);
      appendEventInside(runId, 'execution_fence_settled', { disposition, evidence });
      return getExecutionFence(runId);
    });
  }

  function recoverInterruptedWork() {
    return transaction(() => {
      const leased = database.prepare("SELECT id FROM deliveries WHERE state = 'leased'").all();
      database.prepare("UPDATE deliveries SET state = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE state = 'leased'").run(nowIso());
      const running = database.prepare(`
        SELECT runs.id, execution_fences.state AS fence_state
        FROM runs LEFT JOIN execution_fences ON execution_fences.run_id = runs.id
        WHERE runs.state = 'running'
      `).all();
      let blockedExecutionRuns = 0;
      for (const row of running) {
        if (row.fence_state === 'armed') {
          blockedExecutionRuns += 1;
          database.prepare("UPDATE runs SET state = 'interrupted', error_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
            .run(stringify({ code: 'EXECUTION_REPLAY_BLOCKED', message: '服务重启时执行可能已经产生副作用；已禁止自动重放，请检查隔离产物后交付或丢弃' }), nowIso(), row.id);
          appendEventInside(row.id, 'execution_replay_blocked', { message: '检测到未结清的可写执行，已禁止自动重放' });
        } else {
          database.prepare("UPDATE runs SET state = 'queued', revision = revision + 1, updated_at = ? WHERE id = ?").run(nowIso(), row.id);
          appendEventInside(row.id, 'run_recovered', { message: '服务重启后已重新进入待处理队列' });
        }
      }
      return { recoveredDeliveries: leased.length, recoveredRuns: running.length, blockedExecutionRuns };
    });
  }

  function createContextNode({ id = crypto.randomUUID(), scope, type, title, content, source, status = 'proposed', metadata = {} }) {
    if (!scope || !type || !title || !content || !source) throw new AppError(400, 'INVALID_CONTEXT_NODE', '上下文节点信息不完整');
    if (!['proposed', 'approved', 'rejected', 'superseded'].includes(status)) throw new AppError(400, 'INVALID_CONTEXT_STATUS', '上下文节点状态无效');
    const count = database.prepare('SELECT COUNT(*) AS count FROM context_nodes').get().count;
    if (count >= config.MAX_CONTEXT_NODE_RECORDS) {
      throw new AppError(507, 'CONTEXT_CAPACITY_REACHED', '团队记忆已达到容量上限，请先整理旧节点');
    }
    const superseded = metadata?.supersedesId ? getContextNode(metadata.supersedesId) : null;
    if (superseded && superseded.scope !== scope) throw new AppError(409, 'CONTEXT_SCOPE_MISMATCH', '只能替代同一适用范围内的团队记忆');
    const expiresAt = metadata?.expiresAt || null;
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
      throw new AppError(400, 'INVALID_CONTEXT_EXPIRY', '团队记忆的过期时间必须晚于当前时间');
    }
    const conflicts = database.prepare(`
      SELECT id FROM context_nodes
      WHERE scope = ? AND type = ? AND title = ? AND status = 'approved' AND content <> ?
      ORDER BY updated_at DESC LIMIT 20
    `).all(scope, type, title, content).map((row) => row.id).filter((existingId) => existingId !== superseded?.id);
    if (status === 'approved' && conflicts.length && !superseded) {
      throw new AppError(409, 'CONTEXT_CONFLICT_REQUIRES_SUPERSESSION', '已有同名但内容不同的已批准记忆；请明确选择要替代的旧版本');
    }
    const normalizedMetadata = {
      ...metadata,
      version: Number(superseded?.metadata?.version || 0) + 1,
      expiresAt,
      supersedesId: superseded?.id || null,
      conflictIds: conflicts
    };
    return transaction(() => {
      const now = nowIso();
      database.prepare(`
        INSERT INTO context_nodes (id, scope, type, title, content, source, status, metadata_json, created_at, updated_at, decided_at, decided_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, scope, type, title, content, source, status, stringify(normalizedMetadata), now, now,
        status === 'approved' ? now : null, status === 'approved' ? 'user' : null);
      if (status === 'approved' && superseded) {
        database.prepare("UPDATE context_nodes SET status = 'superseded', updated_at = ?, decided_at = ?, decided_by = 'user' WHERE id = ? AND status = 'approved'")
          .run(now, now, superseded.id);
      }
      return getContextNode(id);
    });
  }

  function getContextNode(id) {
    const row = database.prepare('SELECT * FROM context_nodes WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'CONTEXT_NODE_NOT_FOUND', '上下文节点不存在');
    return {
      id: row.id, scope: row.scope, type: row.type, title: row.title, content: row.content,
      source: row.source, status: row.status, metadata: asJson(row.metadata_json, {}),
      createdAt: row.created_at, updatedAt: row.updated_at, decidedAt: row.decided_at, decidedBy: row.decided_by
    };
  }

  function decideContextNode(id, status, decidedBy, expectedUpdatedAt) {
    if (!['approved', 'rejected', 'superseded'].includes(status)) throw new AppError(400, 'INVALID_CONTEXT_DECISION', '上下文节点决定无效');
    const current = getContextNode(id);
    if (current.status !== 'proposed' || !expectedUpdatedAt || current.updatedAt !== expectedUpdatedAt) {
      throw new AppError(409, 'CONTEXT_NODE_CHANGED', '这条团队记忆已经被其他决定更新，请刷新后重试');
    }
    if (status === 'approved' && current.metadata.expiresAt && Date.parse(current.metadata.expiresAt) <= Date.now()) {
      throw new AppError(409, 'CONTEXT_NODE_EXPIRED', '这条团队记忆已经过期，不能再批准');
    }
    if (status === 'approved' && current.metadata.conflictIds?.length && !current.metadata.supersedesId) {
      throw new AppError(409, 'CONTEXT_CONFLICT_REQUIRES_SUPERSESSION', '这条记忆与已批准版本冲突；请创建明确替代旧版本的新节点');
    }
    const now = nowIso();
    const result = database.prepare(`
      UPDATE context_nodes SET status = ?, decided_at = ?, decided_by = ?, updated_at = ?
      WHERE id = ? AND status = 'proposed' AND updated_at = ?
    `).run(status, now, decidedBy, now, id, expectedUpdatedAt);
    if (result.changes !== 1) throw new AppError(409, 'CONTEXT_NODE_CHANGED', '这条团队记忆已经被其他决定更新，请刷新后重试');
    if (status === 'approved' && current.metadata.supersedesId) {
      database.prepare("UPDATE context_nodes SET status = 'superseded', updated_at = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'approved'")
        .run(now, now, decidedBy, current.metadata.supersedesId);
    }
    return getContextNode(id);
  }

  function listContextNodes({ scope = null, status = null } = {}) {
    const clauses = [];
    const params = [];
    if (scope) { clauses.push('scope = ?'); params.push(scope); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return database.prepare(`SELECT id FROM context_nodes ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, config.MAX_CONTEXT_NODES).map((row) => getContextNode(row.id));
  }

  function resolveContext({ workspacePath = '', query = '', limit = 12 }) {
    const queryTokens = tokenize(query);
    const approved = listContextNodes({ status: 'approved' }).filter((node) => {
      if (node.metadata.expiresAt && Date.parse(node.metadata.expiresAt) <= Date.now()) return false;
      if (!workspacePath) return node.scope === 'global';
      const relative = path.relative(node.scope, workspacePath);
      return node.scope === 'global' || relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    const ranked = approved.map((node) => {
      const nodeTokens = tokenize(`${node.title} ${node.content} ${node.type}`);
      let score = node.scope === workspacePath ? 4 : node.scope === 'global' ? 1 : 2;
      for (const token of queryTokens) if (nodeTokens.has(token)) score += 1;
      return { node, score };
    }).filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || right.node.updatedAt.localeCompare(left.node.updatedAt))
      .slice(0, Math.max(1, Math.min(30, Number(limit) || 12)))
      .map((item) => item.node);
    const digest = crypto.createHash('sha256').update(stringify(ranked.map((node) => ({ id: node.id, updatedAt: node.updatedAt, content: node.content })))).digest('hex');
    return { nodes: ranked, digest };
  }

  function health() {
    const runs = database.prepare("SELECT state, COUNT(*) AS count FROM runs GROUP BY state").all();
    const deliveries = database.prepare("SELECT state, COUNT(*) AS count FROM deliveries GROUP BY state").all();
    const executionFences = database.prepare("SELECT state, COUNT(*) AS count FROM execution_fences GROUP BY state").all();
    return {
      schemaVersion: 2,
      runs: Object.fromEntries(runs.map((row) => [row.state, row.count])),
      deliveries: Object.fromEntries(deliveries.map((row) => [row.state, row.count])),
      executionFences: Object.fromEntries(executionFences.map((row) => [row.state, row.count]))
    };
  }

  function storageStats() {
    const pageSize = database.prepare('PRAGMA page_size').get().page_size;
    const pageCount = database.prepare('PRAGMA page_count').get().page_count;
    const freePages = database.prepare('PRAGMA freelist_count').get().freelist_count;
    return {
      databaseBytes: pageSize * pageCount,
      reusableBytes: pageSize * freePages,
      pageSize,
      pageCount,
      freePages
    };
  }

  function checkpoint({ truncate = false } = {}) {
    const mode = truncate ? 'TRUNCATE' : 'PASSIVE';
    const row = database.prepare(`PRAGMA wal_checkpoint(${mode})`).get();
    return { mode, busy: row.busy, logFrames: row.log, checkpointedFrames: row.checkpointed };
  }

  function backupTo(destination) {
    const target = path.resolve(destination);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) throw new AppError(409, 'BACKUP_TARGET_EXISTS', '备份目标已经存在');
    checkpoint({ truncate: true });
    database.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    return { path: target, bytes: fs.statSync(target).size };
  }

  function compactJsonStorage({ perColumnLimit = 1_000 } = {}) {
    const targets = [
      ['runs', 'input_json'], ['runs', 'result_json'], ['runs', 'error_json'],
      ['run_agents', 'capabilities_json'],
      ['deliveries', 'payload_json'], ['deliveries', 'result_json'], ['deliveries', 'last_error_json'],
      ['messages', 'metadata_json'], ['run_events', 'payload_json'],
      ['context_nodes', 'metadata_json'], ['workspace_handles', 'metadata_json'],
      ['execution_fences', 'settlement_json']
    ];
    const safeLimit = Math.max(1, Math.min(10_000, Number(perColumnLimit) || 1_000));
    return transaction(() => {
      let records = 0;
      let bytesBefore = 0;
      let bytesAfter = 0;
      for (const [table, column] of targets) {
        const rows = database.prepare(`
          SELECT rowid AS row_id, ${column} AS value FROM ${table}
          WHERE ${column} IS NOT NULL AND substr(${column}, 1, 3) <> 'gz:' AND length(${column}) >= ?
          LIMIT ?
        `).all(config.STATE_JSON_COMPRESSION_THRESHOLD_BYTES, safeLimit);
        const update = database.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`);
        for (const row of rows) {
          try {
            const encoded = stringify(JSON.parse(row.value));
            if (!encoded.startsWith('gz:')) continue;
            update.run(encoded, row.row_id);
            records += 1;
            bytesBefore += Buffer.byteLength(row.value);
            bytesAfter += Buffer.byteLength(encoded);
          } catch (_) {
            // 无法解析的记录保持原样，避免维护任务掩盖或扩大损坏。
          }
        }
      }
      return { records, bytesBefore, bytesAfter, logicalSavedBytes: Math.max(0, bytesBefore - bytesAfter) };
    });
  }

  function createWorkspaceHandle({ id = crypto.randomUUID(), runId, sessionId, agentId, sourceRoot, isolatedPath, kind, state = 'prepared', baseRevision = null, metadata = {} }) {
    const existing = database.prepare('SELECT * FROM workspace_handles WHERE run_id = ? AND agent_id = ?').get(runId, agentId);
    if (existing) return getWorkspaceHandle(existing.id);
    const now = nowIso();
    database.prepare(`
      INSERT INTO workspace_handles (id, run_id, session_id, agent_id, source_root, isolated_path, kind, state, base_revision, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, runId, sessionId, agentId, sourceRoot, isolatedPath, kind, state, baseRevision, stringify(metadata), now, now);
    return getWorkspaceHandle(id);
  }

  function getWorkspaceHandle(id) {
    const row = database.prepare('SELECT * FROM workspace_handles WHERE id = ?').get(id);
    if (!row) throw new AppError(404, 'WORKSPACE_HANDLE_NOT_FOUND', '隔离工作区记录不存在');
    return {
      id: row.id,
      runId: row.run_id,
      sessionId: row.session_id,
      agentId: row.agent_id,
      sourceRoot: row.source_root,
      isolatedPath: row.isolated_path,
      kind: row.kind,
      state: row.state,
      baseRevision: row.base_revision,
      metadata: asJson(row.metadata_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  function updateWorkspaceHandle(id, { state, metadata } = {}) {
    const current = getWorkspaceHandle(id);
    database.prepare('UPDATE workspace_handles SET state = ?, metadata_json = ?, updated_at = ? WHERE id = ?')
      .run(state || current.state, stringify(metadata === undefined ? current.metadata : metadata), nowIso(), id);
    return getWorkspaceHandle(id);
  }

  function listWorkspaceHandles(runId) {
    return database.prepare('SELECT id FROM workspace_handles WHERE run_id = ? ORDER BY created_at ASC').all(runId).map((row) => getWorkspaceHandle(row.id));
  }

  function listWorkspaceHandlesByState(states = []) {
    const safeStates = [...new Set(states.filter((state) => typeof state === 'string' && state.trim()))];
    if (!safeStates.length) return [];
    return database.prepare(`SELECT id FROM workspace_handles WHERE state IN (${safeStates.map(() => '?').join(',')}) ORDER BY created_at ASC`)
      .all(...safeStates).map((row) => getWorkspaceHandle(row.id));
  }

  function listSessionWorkspaceHandles(sessionId, { unresolvedOnly = false } = {}) {
    const clauses = ['session_id = ?'];
    const params = [sessionId];
    if (unresolvedOnly) clauses.push("state NOT IN ('delivered', 'discarded', 'empty')");
    return database.prepare(`SELECT id FROM workspace_handles WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`)
      .all(...params).map((row) => getWorkspaceHandle(row.id));
  }

  function deleteSessionData(sessionId) {
    return transaction(() => {
      const runs = database.prepare('SELECT id FROM runs WHERE session_id = ?').all(sessionId).map((row) => row.id);
      const workspaceHandleCount = database.prepare('SELECT COUNT(*) AS count FROM workspace_handles WHERE session_id = ?').get(sessionId).count;
      const proposedContext = runs.length
        ? database.prepare(`SELECT id FROM context_nodes WHERE status = 'proposed' AND source IN (${runs.map(() => '?').join(',')})`).all(...runs.map((runId) => `run:${runId}`))
        : [];
      const runResult = database.prepare('DELETE FROM runs WHERE session_id = ?').run(sessionId);
      // 已批准的节点可能已经成为跨任务团队知识，删除任务时只清理未批准的临时节点。
      for (const row of proposedContext) database.prepare('DELETE FROM context_nodes WHERE id = ?').run(row.id);
      database.prepare('DELETE FROM workspace_handles WHERE session_id = ?').run(sessionId);
      return {
        runs: runResult.changes,
        workspaceHandles: workspaceHandleCount,
        proposedContextNodes: proposedContext.length
      };
    });
  }

  return {
    createRun,
    getRun,
    findRunByRequest,
    listRuns,
    updateRun,
    appendEvent,
    listEvents,
    latestSequence,
    enqueueDelivery,
    getDelivery,
    listDeliveries,
    claimDelivery,
    acknowledgeDelivery,
    failDelivery,
    recordMessage,
    findMessage,
    listMessages,
    listRunAgents,
    setAgentStatus,
    armExecutionFence,
    getExecutionFence,
    settleExecutionFence,
    recoverInterruptedWork,
    createContextNode,
    getContextNode,
    decideContextNode,
    listContextNodes,
    resolveContext,
    createWorkspaceHandle,
    getWorkspaceHandle,
    updateWorkspaceHandle,
    listWorkspaceHandles,
    listWorkspaceHandlesByState,
    listSessionWorkspaceHandles,
    deleteSessionData,
    health,
    storageStats,
    checkpoint,
    backupTo,
    compactJsonStorage,
    isActiveState: (state) => ACTIVE_RUN_STATES.has(state),
    isTerminalState: (state) => TERMINAL_RUN_STATES.has(state),
    close: () => database.close()
  };
}

function migrate(database) {
  const version = database.prepare('PRAGMA user_version').get().user_version;
  if (version > 2) throw new Error(`状态数据库版本 ${version} 高于当前程序支持版本`);
  if (version === 0) database.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      input_json TEXT NOT NULL,
      result_json TEXT,
      error_json TEXT,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(session_id, idempotency_key)
    );
    CREATE INDEX runs_state_kind_idx ON runs(state, kind, created_at);

    CREATE TABLE run_agents (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      focus TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      prompt_version TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, agent_id)
    );

    CREATE TABLE deliveries (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      state TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      attempt_count INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL,
      lease_owner TEXT,
      lease_until TEXT,
      last_error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      acknowledged_at TEXT,
      UNIQUE(run_id, dedupe_key)
    );
    CREATE INDEX deliveries_run_phase_idx ON deliveries(run_id, phase, state);

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      recipient_id TEXT,
      phase TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, sender_id, phase)
    );
    CREATE INDEX messages_session_idx ON messages(session_id, created_at);

    CREATE TABLE run_events (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, sequence)
    );

    CREATE TABLE context_nodes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT
    );
    CREATE INDEX context_nodes_scope_status_idx ON context_nodes(scope, status, updated_at);

    CREATE TABLE workspace_handles (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      source_root TEXT NOT NULL,
      isolated_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      base_revision TEXT,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    PRAGMA user_version = 1;
  `);
  if (database.prepare('PRAGMA user_version').get().user_version === 1) database.exec(`
    CREATE TABLE execution_fences (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      plan_hash TEXT NOT NULL,
      context_digest TEXT NOT NULL,
      workspace_handle_id TEXT NOT NULL REFERENCES workspace_handles(id),
      provider TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('armed', 'settled')),
      settlement_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE INDEX execution_fences_state_idx ON execution_fences(state, updated_at);
    PRAGMA user_version = 2;
  `);
}

module.exports = { createStateCenter, ACTIVE_RUN_STATES, TERMINAL_RUN_STATES };
