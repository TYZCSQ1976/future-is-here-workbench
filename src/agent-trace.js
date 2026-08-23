const crypto = require('node:crypto');

const TRACE_SCHEMA_VERSION = 1;
const TRACE_EVENT_TYPES = new Set(['chat_agent_trace', 'agent_trace']);
const TRACE_KINDS = new Set([
  'invocation', 'step', 'command', 'read', 'file', 'search', 'tool', 'reasoning', 'usage', 'notice'
]);
const TRACE_STATUSES = new Set(['started', 'running', 'succeeded', 'failed', 'cancelled', 'info']);
const TRACE_VISIBILITY = new Set(['full', 'summary', 'provider_limited']);

function redactSecrets(value) {
  return String(value || '')
    .replace(/\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s]+)/gi, '$1=[已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[令牌已隐藏]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function compactText(value, maxLength = 600) {
  const text = redactSecrets(value).replace(/\r\n/g, '\n').trim();
  if (text.length <= maxLength) return { text, truncated: false };
  return { text: `${text.slice(0, Math.max(0, maxLength - 1))}…`, truncated: true };
}

function safeIdentifier(value, maxLength = 160) {
  return compactText(value, maxLength).text.replace(/\s+/g, ' ');
}

function safeJsonValue(value, depth = 0) {
  if (value === null || value === undefined) return value === undefined ? undefined : null;
  if (typeof value === 'string') return compactText(value, depth === 0 ? 800 : 400).text;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'boolean') return value;
  if (depth >= 3) return '[已省略]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeJsonValue(item, depth + 1));
  if (typeof value !== 'object') return compactText(String(value), 200).text;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 30)) {
    const safeKey = safeIdentifier(key, 80);
    const safeItem = safeJsonValue(item, depth + 1);
    if (safeKey && safeItem !== undefined) output[safeKey] = safeItem;
  }
  return output;
}

function normalizeTraceEvent(input, defaults = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const kind = TRACE_KINDS.has(source.kind) ? source.kind
    : source.kind === 'start' || source.kind === 'done' ? 'invocation' : 'tool';
  const inferredStatus = source.kind === 'start' ? 'started'
    : source.kind === 'done' ? 'succeeded' : 'info';
  const status = TRACE_STATUSES.has(source.status) ? source.status : inferredStatus;
  const summarySource = source.summary === undefined ? source.detail : source.summary;
  const summary = compactText(summarySource || '', 800);
  const eventAtValue = source.eventAt || defaults.eventAt;
  const eventAtMs = Date.parse(eventAtValue || '');
  const normalized = {
    schemaVersion: TRACE_SCHEMA_VERSION,
    invocationId: safeIdentifier(source.invocationId || defaults.invocationId || crypto.randomUUID()),
    kind,
    status,
    title: compactText(source.title || defaults.title || '运行事件', 120).text,
    summary: summary.text,
    summaryTruncated: Boolean(source.summaryTruncated || summary.truncated),
    source: safeIdentifier(source.source || defaults.source || 'provider_stream', 80),
    visibility: TRACE_VISIBILITY.has(source.visibility) ? source.visibility
      : TRACE_VISIBILITY.has(defaults.visibility) ? defaults.visibility : 'summary',
    eventAt: Number.isFinite(eventAtMs) ? new Date(eventAtMs).toISOString() : new Date().toISOString()
  };
  for (const key of ['actionId', 'parentActionId', 'model', 'access']) {
    const value = source[key] === undefined ? defaults[key] : source[key];
    if (value !== undefined && value !== null && String(value).trim()) normalized[key] = safeIdentifier(value);
  }
  for (const key of ['input', 'output', 'metrics', 'error']) {
    const value = source[key];
    if (value !== undefined && value !== null) normalized[key] = safeJsonValue(value);
  }
  return normalized;
}

function createTraceId(prefix = 'trace') {
  return `${prefix}-${crypto.randomUUID()}`;
}

function tokenUsageFromTrace(trace) {
  if (trace?.kind !== 'usage') return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const usage = trace.metrics?.usage || {};
  const inputTokens = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const declaredTotal = Number(usage.totalTokens ?? usage.total_tokens ?? 0) || 0;
  return { inputTokens, outputTokens, totalTokens: declaredTotal || inputTokens + outputTokens };
}

function listSessionTracePage(stateCenter, sessionId, { beforeRunId = null, limit = 8 } = {}) {
  const allRuns = stateCenter.listRuns({ sessionId });
  const safeLimit = Math.max(1, Math.min(20, Number(limit) || 8));
  let end = allRuns.length;
  if (beforeRunId) {
    const found = allRuns.findIndex((run) => run.id === beforeRunId);
    if (found >= 0) end = found;
  }
  const start = Math.max(0, end - safeLimit);
  const pageRuns = allRuns.slice(start, end);
  const traces = [];
  const pageUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const runs = pageRuns.map((run) => {
    let eventCount = 0;
    const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    for (const event of stateCenter.listEvents(run.id)) {
      if (!TRACE_EVENT_TYPES.has(event.type)) continue;
      eventCount += 1;
      traces.push({
        runId: run.id,
        runKind: run.kind,
        runState: run.state,
        runCreatedAt: run.createdAt,
        sequence: event.sequence,
        createdAt: event.createdAt,
        ...event.payload
      });
      const usage = tokenUsageFromTrace(event.payload);
      tokenUsage.inputTokens += usage.inputTokens;
      tokenUsage.outputTokens += usage.outputTokens;
      tokenUsage.totalTokens += usage.totalTokens;
    }
    return {
      id: run.id,
      kind: run.kind,
      state: run.state,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      eventCount,
      tokenUsage
    };
  });
  for (const run of runs) {
    pageUsage.inputTokens += run.tokenUsage.inputTokens;
    pageUsage.outputTokens += run.tokenUsage.outputTokens;
    pageUsage.totalTokens += run.tokenUsage.totalTokens;
  }
  return {
    schemaVersion: TRACE_SCHEMA_VERSION,
    sessionId,
    runs,
    traces,
    tokenUsage: pageUsage,
    page: {
      hasMore: start > 0,
      beforeRunId: start > 0 && pageRuns.length ? pageRuns[0].id : null
    }
  };
}

module.exports = {
  TRACE_SCHEMA_VERSION,
  TRACE_EVENT_TYPES,
  compactText,
  createTraceId,
  listSessionTracePage,
  normalizeTraceEvent,
  redactSecrets,
  safeJsonValue,
  tokenUsageFromTrace
};
