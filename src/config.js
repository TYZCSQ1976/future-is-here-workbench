const path = require('path');
const os = require('os');
const fs = require('fs');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const defaultWorkspaceRoots = [PROJECT_ROOT, path.join(os.homedir(), 'work'), path.join(os.homedir(), 'Desktop')]
  .filter((item, index, list) => fs.existsSync(item) && list.indexOf(item) === index);
const workspaceRoots = String(process.env.WORKBENCH_WORKSPACE_ROOTS || '')
  .split(path.delimiter)
  .map((item) => item.trim())
  .filter(Boolean);
const PORT = Number.parseInt(process.env.PORT || '3456', 10);
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN = (process.env.WORKBENCH_TOKEN || '').trim();
const ALLOW_AUTO_GATE = process.env.ALLOW_AUTO_GATE === 'true';
const MAX_PROVIDER_PROCESSES = Number.parseInt(process.env.MAX_PROVIDER_PROCESSES || '4', 10);
const MAX_PROVIDER_QUEUE = Number.parseInt(process.env.MAX_PROVIDER_QUEUE || '24', 10);
const DETERMINISTIC_CHECK_TIMEOUT_MS = Number.parseInt(process.env.DETERMINISTIC_CHECK_TIMEOUT_MS || '120000', 10);
const DETERMINISTIC_CHECK_MAX_OUTPUT_CHARS = Number.parseInt(process.env.DETERMINISTIC_CHECK_MAX_OUTPUT_CHARS || '16000', 10);

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT 必须是 1 到 65535 之间的整数');
}

if (!Number.isInteger(MAX_PROVIDER_PROCESSES) || MAX_PROVIDER_PROCESSES < 1 || MAX_PROVIDER_PROCESSES > 12) {
  throw new Error('MAX_PROVIDER_PROCESSES 必须是 1 到 12 之间的整数');
}

if (!Number.isInteger(MAX_PROVIDER_QUEUE) || MAX_PROVIDER_QUEUE < 1 || MAX_PROVIDER_QUEUE > 200) {
  throw new Error('MAX_PROVIDER_QUEUE 必须是 1 到 200 之间的整数');
}

if (!Number.isInteger(DETERMINISTIC_CHECK_TIMEOUT_MS) || DETERMINISTIC_CHECK_TIMEOUT_MS < 5_000 || DETERMINISTIC_CHECK_TIMEOUT_MS > 10 * 60_000) {
  throw new Error('DETERMINISTIC_CHECK_TIMEOUT_MS 必须在 5000 到 600000 毫秒之间');
}

if (!Number.isInteger(DETERMINISTIC_CHECK_MAX_OUTPUT_CHARS) || DETERMINISTIC_CHECK_MAX_OUTPUT_CHARS < 2_000 || DETERMINISTIC_CHECK_MAX_OUTPUT_CHARS > 200_000) {
  throw new Error('DETERMINISTIC_CHECK_MAX_OUTPUT_CHARS 必须在 2000 到 200000 之间');
}

// 远程监听必须显式配置访问令牌，避免把本机 AI 能力裸奔到局域网或公网。
if (!isLoopbackHost(HOST) && !AUTH_TOKEN) {
  throw new Error('HOST 不是本机地址时必须设置 WORKBENCH_TOKEN');
}

module.exports = {
  PROJECT_ROOT,
  WORKSPACE_ROOTS: workspaceRoots.length > 0 ? workspaceRoots : defaultWorkspaceRoots,
  MAX_WORKSPACE_FILES: 20_000,
  MAX_WORKSPACE_ENTRIES: 40_000,
  MAX_WORKSPACE_DEPTH: 64,
  WORKSPACE_SNAPSHOT_TIMEOUT_MS: 3_000,
  PUBLIC_DIR: path.join(PROJECT_ROOT, 'public'),
  SESSIONS_DIR: path.join(PROJECT_ROOT, 'sessions'),
  RUNTIME_DIR: path.join(PROJECT_ROOT, '.workbench'),
  STATE_DB_PATH: path.join(PROJECT_ROOT, '.workbench', 'state.sqlite3'),
  SERVER_PID_PATH: path.join(PROJECT_ROOT, '.workbench', 'server.pid.json'),
  BACKUP_ROOT: path.join(PROJECT_ROOT, '.workbench', 'backups'),
  MAX_BACKUPS: 2,
  HOST,
  PORT,
  AUTH_TOKEN,
  ALLOW_AUTO_GATE,
  // 图片以 base64 进入请求；总量仍受下面的图片数量和大小上限约束。
  MAX_BODY_BYTES: 16 * 1024 * 1024,
  MAX_IMAGES: 4,
  MAX_IMAGE_BYTES: 4 * 1024 * 1024,
  MAX_TOTAL_IMAGE_BYTES: 6 * 1024 * 1024,
  // 图片和旧版文件夹附件也有独立总账，避免长时间使用后无上限累积。
  MAX_ATTACHMENT_SESSION_BYTES: 50 * 1024 * 1024,
  MAX_ATTACHMENT_GLOBAL_BYTES: 200 * 1024 * 1024,
  // 参考资料走独立的二进制分块上传，不占用 JSON 请求体额度。
  MAX_REFERENCE_UPLOAD_BYTES: 100 * 1024 * 1024,
  MAX_REFERENCE_GLOBAL_BYTES: 500 * 1024 * 1024,
  MAX_REFERENCE_FILES: 500,
  REFERENCE_CHUNK_BYTES: 4 * 1024 * 1024,
  MAX_REFERENCE_EXTRACTED_CHARS_PER_FILE: 160_000,
  MAX_REFERENCE_OCR_PAGES: 12,
  MAX_REFERENCE_EXTRACTED_BYTES_PER_SESSION: 5 * 1024 * 1024,
  MAX_REFERENCE_CONTEXT_CHARS: 60_000,
  REFERENCE_INCOMPLETE_TTL_MS: 24 * 60 * 60 * 1000,
  MAX_TEXT_CHARS: 20_000,
  MAX_NAME_CHARS: 80,
  MAX_CONTEXT_MESSAGES: 20,
  MAX_CONTEXT_CHARS: 50_000,
  MAX_STORED_MESSAGES: 500,
  // Claude/Codex 的 JSONL 包装会携带事件元数据，可能远大于最终回答；仍设置有界传输上限，避免内存失控。
  MAX_PROVIDER_TRANSPORT_BYTES: 8 * 1024 * 1024,
  MAX_PROVIDER_OUTPUT_CHARS: 120_000,
  // 交互式对话需要兼顾冷启动开销与模型响应时间；过短会导致频繁超时中断。
  // Claude 经中转网关调用时仅等待首个 token 就可能耗费 7—9 秒，预算必须覆盖。
  CHAT_PROVIDER_TIMEOUT_MS: 180_000,
  // 协作需要结构化输出，允许模型完成一次完整发言，但不应拖到执行任务的时长。
  COLLAB_PROVIDER_TIMEOUT_MS: 240_000,
  // 隔离执行（写代码/调试）单轮确实更长：多轮工具调用叠加网关延迟。
  EXECUTION_PROVIDER_TIMEOUT_MS: 600_000,
  PROVIDER_TIMEOUT_MS: 180_000,
  // dsh 使用的模型：默认 deepseek-chat。dsh 0.1.0-rc.6 的 headless 对
  // deepseek-v4-flash（ZAI 网关）的流解析存在 bug，会报 TRANSPORT 错误；
  // 如 DeepSeek 修复后，可通过 DSH_MODEL=deepseek-v4-flash 切换。
  DSH_MODEL: String(process.env.DSH_MODEL || 'deepseek-chat').trim().slice(0, 80),
  MAX_ACTIVE_JOBS: 8,
  MAX_PROVIDER_PROCESSES,
  MAX_PROVIDER_QUEUE,
  DETERMINISTIC_CHECK_TIMEOUT_MS,
  DETERMINISTIC_CHECK_MAX_OUTPUT_CHARS,
  MAX_SSE_CONNECTIONS: 32,
  MAX_SSE_REPLAY_EVENTS: 500,
  MAX_SSE_REPLAY_BYTES: 1024 * 1024,
  // 慢速浏览器只允许积压少量 SSE 数据；超过后主动断开，由事件游标重连回放。
  MAX_SSE_PENDING_BYTES: 256 * 1024,
  MAX_SESSIONS: 1_000,
  MAX_CONTEXT_NODE_RECORDS: 5_000,
  MAX_FORMAT_REPAIRS: 1,
  MAX_WORKFLOW_CHECKPOINTS: 100,
  MAX_TEAM_SIZE: 6,
  MAX_DIALOGUE_ROUNDS: 5,
  DELIVERY_LEASE_MS: 4 * 60_000,
  // 对话失败后由用户决定是否重试，避免一次点击隐式等待两轮 Provider。
  CHAT_MAX_DELIVERY_ATTEMPTS: 1,
  MAX_DELIVERY_ATTEMPTS: 2,
  // 轨迹保留原有事件与顺序；大型结构化记录只做可逆 gzip 压缩。
  MAX_RUN_EVENTS: 5_000,
  MAX_STATE_RECORD_BYTES: 512 * 1024,
  STATE_JSON_COMPRESSION_THRESHOLD_BYTES: 2 * 1024,
  MAX_SERVER_LOG_BYTES: 1024 * 1024,
  // 总占用只做透明提醒，不以“轻量”为由删除用户历史或降低功能上限。
  STORAGE_WARNING_BYTES: 500 * 1024 * 1024,
  PROVIDER_TEMP_TTL_MS: 60 * 60 * 1000,
  STORAGE_MAINTENANCE_INTERVAL_MS: 15 * 60 * 1000,
  MAX_CONTEXT_NODES: 200,
  PROVIDER_KEYS: ['claude', 'codex', 'dsh'],
  COLLAB_MODE_KEYS: ['cocreation', 'review', 'adversarial', 'division']
};
