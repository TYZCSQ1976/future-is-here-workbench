const { spawn } = require('child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('./config');
const { compactText, createTraceId, normalizeTraceEvent, safeJsonValue } = require('./agent-trace');

class ProviderError extends Error {
  constructor(code, userMessage, cause) {
    super(userMessage);
    this.name = 'ProviderError';
    this.code = code;
    this.userMessage = userMessage;
    this.cause = cause;
  }
}

// 只把 Provider 真正需要的环境变量交给子进程，避免无关业务密钥被整包继承。
const COMMON_PROVIDER_ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'NO_COLOR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
  'DSH_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'
];
const PROVIDER_CREDENTIAL_KEYS = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
  dsh: [],
  probe: []
};
const processQueue = [];
let activeProcesses = 0;
let providerShuttingDown = false;
const activeProviderChildren = new Set();
const probeCache = new Map();
const probeInFlight = new Map();
const providerMetrics = new Map(config.PROVIDER_KEYS.map((provider) => [provider, { calls: 0, successes: 0, failures: 0, latencies: [], errors: {} }]));

// dsh 通常通过 npx 缓存安装，服务进程的 PATH 往往不含该目录（claude/codex 在
// /opt/homebrew/bin 等系统目录）。这里在 PATH 中找不到时再扫描 npx 缓存，避免
// 出现“命令明明装了却 ENOENT”的故障。结果缓存，进程内只解析一次。
let resolvedDshCommand = null;
function findOnPath(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {}
  }
  return null;
}

function resolveDshCommand() {
  if (resolvedDshCommand) return resolvedDshCommand;
  if (process.env.DSH_CLI_PATH) {
    resolvedDshCommand = process.env.DSH_CLI_PATH;
    return resolvedDshCommand;
  }
  const onPath = findOnPath('dsh');
  if (onPath) { resolvedDshCommand = onPath; return onPath; }
  try {
    const npxRoot = path.join(os.homedir(), '.npm', '_npx');
    if (fs.existsSync(npxRoot)) {
      const candidates = fs.readdirSync(npxRoot)
        .map((entry) => path.join(npxRoot, entry, 'node_modules', '.bin', 'dsh'))
        .filter((candidate) => {
          try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch (_) { return false; }
        })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (candidates.length) { resolvedDshCommand = candidates[0]; return candidates[0]; }
    }
  } catch (_) {}
  resolvedDshCommand = 'dsh';
  return 'dsh';
}

// Claude 调用使用 --setting-sources project 与用户个人配置隔离（不再加载用户的全局
// 人设、思考强度等设置），但凭据往往只存在于用户 settings.json 的 env 里；
// 因此启动时一次性取出 ANTHROPIC_* 相关变量，通过子进程环境显式交给 claude。
// 只取凭据类变量：CLAUDE_CODE_* 等行为类变量会被故意丢弃，避免个人偏好泄漏进工作台。
let claudeCredentialEnvCache = null;
function getClaudeCredentialEnv() {
  if (claudeCredentialEnvCache) return claudeCredentialEnvCache;
  claudeCredentialEnvCache = {};
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const env = settings && typeof settings.env === 'object' ? settings.env : {};
    for (const key of Object.keys(env)) {
      if (/^ANTHROPIC_[A-Z0-9_]+$/.test(key) && typeof env[key] === 'string' && env[key] !== '') {
        claudeCredentialEnvCache[key] = env[key];
      }
    }
  } catch (_) {
    // 读取失败（文件缺失或格式异常）时退回纯环境变量通道，不阻塞调用。
  }
  return claudeCredentialEnvCache;
}

// 错误信息脱敏：Provider 的 stderr 可能包含令牌，展示给用户前先清洗常见凭据形式。
function sanitizeProviderStderr(text) {
  return String(text || '')
    // 兼容 “API_KEY=…” 与 “TEST_API_KEY=…” 两种形态。
    .replace(/\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD))\s*=\s*([^\s]+)/g, '$1=[已隐藏]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function drainProcessQueue() {
  while (activeProcesses < config.MAX_PROVIDER_PROCESSES && processQueue.length > 0) {
    const entry = processQueue.shift();
    if (entry.signal?.aborted) {
      entry.reject(new ProviderError('PROVIDER_CANCELLED', 'AI 请求已取消'));
      continue;
    }
    if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
    activeProcesses += 1;
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        activeProcesses -= 1;
        drainProcessQueue();
      });
  }
}

function scheduleProcess(task, signal) {
  return new Promise((resolve, reject) => {
    if (providerShuttingDown) return reject(new ProviderError('PROVIDER_SHUTTING_DOWN', '工作台正在安全停止，不再接受新的 AI 请求'));
    if (signal?.aborted) return reject(new ProviderError('PROVIDER_CANCELLED', 'AI 请求已取消'));
    if (processQueue.length >= config.MAX_PROVIDER_QUEUE) {
      return reject(new ProviderError('PROVIDER_QUEUE_FULL', 'AI 请求队列已满，请稍后再试'));
    }
    const entry = { task, signal, resolve, reject, onAbort: null };
    if (signal) {
      entry.onAbort = () => {
        const index = processQueue.indexOf(entry);
        if (index >= 0) {
          processQueue.splice(index, 1);
          reject(new ProviderError('PROVIDER_CANCELLED', 'AI 请求已取消'));
        }
      };
      signal.addEventListener('abort', entry.onAbort, { once: true });
    }
    processQueue.push(entry);
    drainProcessQueue();
  });
}

function getQueueStats() {
  return {
    active: activeProcesses,
    queued: processQueue.length,
    processLimit: config.MAX_PROVIDER_PROCESSES,
    queueLimit: config.MAX_PROVIDER_QUEUE,
    limit: config.MAX_PROVIDER_PROCESSES
  };
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function getMetrics() {
  return Object.fromEntries([...providerMetrics.entries()].map(([provider, metric]) => [provider, {
    calls: metric.calls,
    successes: metric.successes,
    failures: metric.failures,
    successRate: metric.calls ? Number((metric.successes / metric.calls).toFixed(4)) : null,
    p50LatencyMs: percentile(metric.latencies, 0.5),
    p95LatencyMs: percentile(metric.latencies, 0.95),
    errors: { ...metric.errors }
  }]));
}

function buildProviderEnv(provider = 'probe', source = process.env) {
  const env = {};
  const keys = [...COMMON_PROVIDER_ENV_KEYS, ...(PROVIDER_CREDENTIAL_KEYS[provider] || [])];
  for (const key of keys) {
    if (typeof source[key] === 'string' && source[key] !== '') env[key] = source[key];
  }
  const extraName = provider === 'claude'
    ? 'PROVIDER_ENV_ALLOWLIST_EXTRA_CLAUDE'
    : provider === 'codex' ? 'PROVIDER_ENV_ALLOWLIST_EXTRA_CODEX'
      : provider === 'dsh' ? 'PROVIDER_ENV_ALLOWLIST_EXTRA_DSH' : '';
  const extraKeys = String(extraName ? source[extraName] || '' : '')
    .split(',')
    .map((key) => key.trim())
    .filter((key) => /^[A-Z][A-Z0-9_]*$/.test(key));
  for (const key of extraKeys) {
    if (typeof source[key] === 'string' && source[key] !== '') env[key] = source[key];
  }
  // Claude 个人配置被隔离后，联网凭据改由这里显式注入；进程环境里已有的同名变量优先。
  if (provider === 'claude') {
    for (const [key, value] of Object.entries(getClaudeCredentialEnv())) {
      if (typeof env[key] !== 'string' || env[key] === '') env[key] = value;
    }
  }
  return env;
}

function getProviderTransportLimit(provider) {
  return ['claude', 'codex'].includes(provider)
    ? config.MAX_PROVIDER_TRANSPORT_BYTES
    : config.MAX_PROVIDER_OUTPUT_CHARS;
}

function assertProviderReplySize(provider, text) {
  if (String(text || '').length > config.MAX_PROVIDER_OUTPUT_CHARS) {
    throw new ProviderError('PROVIDER_OUTPUT_TOO_LARGE', `${provider} 的最终回答过长，请缩小问题范围`);
  }
}

// Provider 子进程的兜底工作目录：没有绑定工作区的只读调用在这里运行。
// 不能回退到服务器自身项目根，否则“协作成员”可以枚举服务器源码、
// sessions/ 下的其他任务数据和 .workbench/state.sqlite3 控制面数据库。
let neutralProviderCwd = null;
function getNeutralProviderCwd() {
  if (neutralProviderCwd) return neutralProviderCwd;
  neutralProviderCwd = path.join(config.RUNTIME_DIR, 'provider-home');
  try { fs.mkdirSync(neutralProviderCwd, { recursive: true, mode: 0o700 }); } catch (_) {}
  return neutralProviderCwd;
}

function escapeSandboxLiteral(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function writableIsolation(provider, workspacePath) {
  if (provider === 'codex') {
    return { enforced: true, mechanism: 'codex_native_workspace_write', workspacePath, limitations: [] };
  }
  if (provider === 'dsh') {
    return {
      enforced: false,
      mechanism: 'unavailable',
      workspacePath,
      limitations: ['DeepSeek Harness 当前没有工作台可验证的宿主机写入沙箱']
    };
  }
  if (provider === 'claude' && process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
    return {
      enforced: true,
      mechanism: 'macos_sandbox_exec',
      workspacePath,
      limitations: ['模型联网调用仍被允许；文件读取与写入由工作区规则限制']
    };
  }
  return { enforced: false, mechanism: 'unavailable', workspacePath, limitations: ['当前系统没有可验证的 Provider 写入沙箱'] };
}

function prepareProviderSpawn(command, args, options) {
  if (options.access !== 'workspace_write') return { command, args, tempPath: null, isolation: null };
  const workspacePath = fs.realpathSync(options.cwd || '');
  const isolation = writableIsolation(options.provider, workspacePath);
  if (!isolation.enforced) {
    throw new ProviderError('PROVIDER_WRITE_SANDBOX_UNAVAILABLE', `${options.provider} 当前不能安全担任可写执行者；请选择 Codex 或 Claude，DeepSeek 仍可参与讨论和只读审查`);
  }
  if (providerShuttingDown) throw new ProviderError('PROVIDER_SHUTTING_DOWN', '工作台正在安全停止');
  if (isolation.mechanism !== 'macos_sandbox_exec') return { command, args, tempPath: null, isolation };
  const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), 'future-workbench-provider-'));
  const profile = [
    '(version 1)',
    '(allow default)',
    `(deny file-read* (subpath "${escapeSandboxLiteral(os.homedir())}"))`,
    `(allow file-read* (subpath "${escapeSandboxLiteral(workspacePath)}"))`,
    `(allow file-read* (subpath "${escapeSandboxLiteral(tempPath)}"))`,
    '(deny file-write*)',
    `(allow file-write* (subpath "${escapeSandboxLiteral(workspacePath)}"))`,
    `(allow file-write* (subpath "${escapeSandboxLiteral(tempPath)}"))`
  ].join('\n');
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, command, ...args], tempPath, isolation };
}

function runProcessNow(command, args, options = {}) {
  const isInteractiveChat = ['answer', 'cross_check'].includes(options.phase);
  // 隔离执行（写代码/调试）单轮可能很长，给独立的宽预算；其余按阶段分级。
  const isExecution = options.phase === 'execute' || options.access === 'workspace_write';
  const timeoutMs = options.timeoutMs || (
    isExecution
      ? config.EXECUTION_PROVIDER_TIMEOUT_MS
      : options.phase === 'collaboration'
        ? config.COLLAB_PROVIDER_TIMEOUT_MS
        : isInteractiveChat ? config.CHAT_PROVIDER_TIMEOUT_MS : config.PROVIDER_TIMEOUT_MS
  );
  // JSONL 的传输包装和最终答案是两回事：这里只限制子进程传输体，最终文本在解析后另行校验。
  const maxTransportBytes = options.maxOutputChars || options.maxTransportBytes || getProviderTransportLimit(options.provider);

  const spawnSpec = prepareProviderSpawn(command, args, options);
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderr = '';
    let timedOut = false;
    let outputTooLarge = false;
    let settled = false;
    let forceKillTimer = null;

    const terminate = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (_) {}
    };

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: options.cwd || getNeutralProviderCwd(),
      env: { ...buildProviderEnv(options.provider || 'probe'), ...(spawnSpec.tempPath ? { TMPDIR: spawnSpec.tempPath } : {}) },
      shell: false,
      detached: process.platform !== 'win32',
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeProviderChildren.add(child);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      activeProviderChildren.delete(child);
      if (spawnSpec.tempPath) {
        try { fs.rmSync(spawnSpec.tempPath, { recursive: true, force: true }); } catch (_) {}
      }
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (error) reject(error); else resolve(value);
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      forceKillTimer = setTimeout(() => terminate('SIGKILL'), 5_000);
      forceKillTimer.unref?.();
    }, timeoutMs);
    // 定时器不持有事件循环：Provider 已经结束后，等待中的超时定时器不应拖住进程退出。
    timeoutTimer.unref?.();

    child.stdout.on('data', (chunk) => {
      if (outputTooLarge) return;
      // 流式回调：在缓冲之前把原始数据交给调用方，实现逐字输出。
      if (options.onRawData) {
        try { options.onRawData(chunk); } catch (_) {}
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxTransportBytes - stdoutBytes);
      if (remaining > 0) stdoutChunks.push(buffer.subarray(0, remaining));
      stdoutBytes += buffer.length;
      if (stdoutBytes > maxTransportBytes) {
        outputTooLarge = true;
        child.stdout.pause();
        child.stdout.destroy();
        terminate('SIGTERM');
        forceKillTimer = setTimeout(() => terminate('SIGKILL'), 1_000);
        forceKillTimer.unref?.();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8_000);
    });
    child.on('error', (error) => {
      // 用户终止或信号取消导致的 AbortError 不是“无法启动”，要如实分类为已取消。
      if (error.name === 'AbortError' || options.signal?.aborted) {
        return finish(new ProviderError('PROVIDER_CANCELLED', `${command} 已取消`));
      }
      // 最常见原因是命令不在 PATH 中（ENOENT），给出可操作的提示。
      const hint = error.code === 'ENOENT'
        ? `找不到命令「${command}」。请确认已安装并加入 PATH；dsh 可通过环境变量 DSH_CLI_PATH 指定完整路径`
        : `无法启动：${error.message || error.code || '未知错误'}`;
      finish(new ProviderError('PROVIDER_START_FAILED', `${command} 暂时无法启动（${hint}）`, error));
    });
    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrDetail = sanitizeProviderStderr(stderr);
      if (options.signal?.aborted) return finish(new ProviderError('PROVIDER_CANCELLED', `${command} 已取消`));
      if (timedOut) return finish(new ProviderError('PROVIDER_TIMEOUT', `${command} 响应超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`));
      if (outputTooLarge) {
        return finish(new ProviderError('PROVIDER_OUTPUT_TOO_LARGE',
          `${command} 传输数据超过 ${Math.round(maxTransportBytes / 1024 / 1024)}MB 上限，已安全中断`));
      }
      if (code !== 0) {
        const detail = stderrDetail ? `）：${stderrDetail.slice(-500)}` : '';
        return finish(new ProviderError('PROVIDER_FAILED', `${command} 调用失败（退出码 ${code}${detail}`, { code, signal, stderr }));
      }
      if (!stdout.trim()) return finish(new ProviderError('PROVIDER_EMPTY_RESPONSE', `${command} 没有返回内容`));
      finish(null, stdout.trim());
    });
  });
}

function shutdownProviderProcesses() {
  providerShuttingDown = true;
  while (processQueue.length) {
    const entry = processQueue.shift();
    entry.reject(new ProviderError('PROVIDER_SHUTTING_DOWN', '工作台正在安全停止，排队中的 AI 请求已取消'));
  }
  for (const child of activeProviderChildren) {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch (_) {}
  }
  return { active: activeProviderChildren.size, queued: processQueue.length };
}

function providerRuntimeStatus() {
  return { shuttingDown: providerShuttingDown, active: activeProviderChildren.size, queued: processQueue.length };
}

function runProcess(command, args, options = {}) {
  return scheduleProcess(() => runProcessNow(command, args, options), options.signal);
}

function parseCodexJSONL(stdout) {
  let finalMessage = '';
  for (const line of String(stdout || '').trim().split('\n')) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        finalMessage = event.item.text.trim();
      }
    } catch (_) {}
  }
  return finalMessage;
}

// 自适应思考分级：只在“百分之百确定是寒暄/应答”时才降低档（精确优先，宁可多想
// 不可误判），执行/写码/调试阶段升到高档。判据用用户的原始消息 userText（包装后
// 的提示词永远很长，不能作为依据）；拿不到原始消息时保持各 CLI 默认档，不猜。
// 注意：真正的“AI 自评复杂度”需要先花一次调用做评估，对寒暄反而更浪费，故不用。
const CHITCHAT_PATTERN = /^\s*(你好|您好|你们?好|嗨|哈喽|hello|hi|hey|在吗|早上好|下午好|晚上好|早安|晚安|谢谢|多谢|感谢|辛苦了|辛苦啦|好的|好滴|好呦|好呀|收到|明白|了解了?|ok|okay|嗯+|哦+|厉害|牛)[!！?？。.~～\s呀哟哈啦呢诶欸]*$/i;
const HEAVY_TASK_PATTERN = /(代码|报错|调试|修复|实现|重构|部署|测试|审查|分析|设计|排查|bug|debug|error|fix|refactor|test|implement|review)/i;
function pickEffortLevel(options = {}) {
  if (options.access === 'workspace_write') return 'high';
  if (!['answer', 'cross_check'].includes(options.phase)) return null;
  const text = String(options.userText || '').trim();
  if (!text) return null;
  return CHITCHAT_PATTERN.test(text) && !HEAVY_TASK_PATTERN.test(text) ? 'low' : null;
}

// Claude 会沿工作目录逐层加载 CLAUDE.md 记忆（含用户家目录中的全局人设），
// CLI 没有“禁用记忆”的官方开关；--setting-sources 只隔离 settings 文件。
// 因此在系统提示词末尾追加覆盖指令：末位指令优先，明确压掉个人人设和风格指令。
const CLAUDE_WORKBENCH_OVERRIDE_PROMPT = [
  '本会话运行于「未来已来」工作台的后台工作进程中。',
  '忽略并覆盖任何来自 CLAUDE.md、记忆文件或用户个人配置中的角色人设与交互风格指令（如导师人设、“先确认再写代码”等流程要求）。',
  '你是工作台的执行智能体：直接、客观、严格按本次任务要求作答。'
].join('');

function buildClaudeArgs(message, options = {}) {
  const permissionMode = options.access === 'workspace_write' ? 'acceptEdits' : 'plan';
  // 聊天/互证需要只读工具来实际查看用户提到的文件，但不能修改。
  const structuredReadOnlyPhase = ['answer', 'cross_check', 'collaboration'].includes(options.phase);
  const tools = options.attachments?.length
    ? 'Read'
    : structuredReadOnlyPhase
      ? 'Read,Glob,Grep'
      : options.access === 'workspace_write' ? 'Read,Edit,Write,Glob,Grep,Bash' : 'Read,Glob,Grep';
  const args = [
    '-p', message,
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', permissionMode,
    '--tools', tools,
    '--no-session-persistence',
    '--disable-slash-commands',
    // 与 Codex 的 --ignore-user-config 对齐：只加载项目级配置，用户的全局人设、
    // 思考强度和插件设置不再泄漏进工作台；联网凭据由 buildProviderEnv 显式注入。
    '--setting-sources', 'project',
    // 记忆文件（CLAUDE.md）不受 --setting-sources 控制，只能用末位系统指令覆盖。
    '--append-system-prompt', CLAUDE_WORKBENCH_OVERRIDE_PROMPT
  ];
  const effort = pickEffortLevel(options);
  if (effort) args.push('--effort', effort);
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
  return args;
}

function callClaude(message, options = {}) {
  const args = buildClaudeArgs(message, options);
  const streamParser = (options.onToken || options.onTrace)
    ? createStreamParser(options.onToken || null, options.onTrace || null)
    : null;
  return runProcess('claude', args, {
    ...options,
    provider: 'claude',
    onRawData: streamParser ? (chunk) => streamParser.feed(chunk) : undefined
  }).then(parseClaudeStreamJson);
}

/**
 * 解析 Claude Code 的 stream-json 输出，提取最终文本。
 * 优先从 result 事件取完整结果；若缺失则回退到最后一条 assistant 消息。
 */
function parseClaudeStreamJson(stdout) {
  const trimmed = String(stdout || '').trim();
  if (!trimmed) return '';
  const lines = trimmed.split('\n');
  // result 事件通常在最后，从后往前找。
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === 'result' && typeof event.result === 'string') {
        return event.result.trim();
      }
    } catch (_) {}
  }
  // 回退：取最后一条 assistant 消息中的文本块。
  let text = '';
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') text = block.text;
        }
      }
    } catch (_) {}
  }
  return text.trim();
}

/**
 * 创建一个逐行解析 stream-json 的状态机。
 * 每收到一段 stdout chunk，feed() 会按换行符切分出完整 JSON 行并解析；
 * 当 assistant 事件携带文本时，计算与上一次的增量（delta）并调用 onToken。
 */
// 把工具调用参数压缩成一行人话，用于轨迹展示（只取关键字段，避免泄漏大段内容）。
function summarizeToolInput(name, input) {
  const value = input && typeof input === 'object' ? input : {};
  const normalizedName = String(name || '').toLowerCase();
  const brief = (text, max = 120) => {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}…` : flat;
  };
  if (normalizedName === 'read') return brief(value.file_path || value.path || '');
  if (['edit', 'write', 'notebookedit'].includes(normalizedName)) return brief(value.file_path || value.notebook_path || value.path || '');
  if (['bash', 'shell', 'terminal'].includes(normalizedName)) return brief(value.command || value.cmd || '');
  if (normalizedName === 'glob' || normalizedName === 'grep') return brief(value.pattern || '');
  if (normalizedName === 'webfetch' || normalizedName === 'websearch' || normalizedName === 'web_fetch' || normalizedName === 'web_search') return brief(value.url || value.query || '');
  return brief(JSON.stringify(value).replace(/^\{|\}$/g, ''));
}

function traceKindForTool(name) {
  if (/bash|shell|command|terminal/i.test(name || '')) return 'command';
  if (/read/i.test(name || '')) return 'read';
  if (['Edit', 'Write', 'NotebookEdit'].includes(name) || /write|edit|patch|file_change/i.test(name || '')) return 'file';
  if (/search|fetch|web/i.test(name || '')) return 'search';
  return 'tool';
}

function traceInputForTool(name, input) {
  const value = input && typeof input === 'object' ? input : {};
  const normalizedName = String(name || '').toLowerCase();
  if (['bash', 'shell', 'terminal'].includes(normalizedName)) return { command: value.command || value.cmd || '' };
  if (['read', 'edit', 'write', 'notebookedit'].includes(normalizedName)) {
    return { path: value.file_path || value.notebook_path || value.path || '' };
  }
  if (normalizedName === 'glob' || normalizedName === 'grep') return { pattern: value.pattern || '', path: value.path || '' };
  if (normalizedName === 'webfetch' || normalizedName === 'web_fetch') return { url: value.url || '' };
  if (normalizedName === 'websearch' || normalizedName === 'web_search') return { query: value.query || '' };
  return { tool: name || 'unknown', arguments: safeJsonValue(value) };
}

function flattenTraceContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(flattenTraceContent).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  if (value.type === 'reasoning') return '';
  if (value.content !== undefined) return flattenTraceContent(value.content);
  return '';
}

function createStreamParser(onToken, onTrace) {
  let lineBuffer = '';
  let lastFullText = '';
  const actions = new Map();
  const completedActions = new Set();
  const emitTrace = (trace) => {
    if (!onTrace || !trace) return;
    try { onTrace(trace); } catch (_) {}
  };
  return {
    feed(chunk) {
      lineBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch (_) { continue; }
        if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use') {
              const actionId = String(block.id || createTraceId('claude-tool'));
              if (actions.has(actionId)) continue;
              actions.set(actionId, { name: block.name, startedAt: Date.now() });
              emitTrace({
                actionId,
                kind: traceKindForTool(block.name),
                status: 'started',
                title: String(block.name || '工具调用'),
                summary: summarizeToolInput(block.name, block.input),
                input: traceInputForTool(block.name, block.input),
                source: 'claude_stream_json',
                visibility: 'summary'
              });
              continue;
            }
            if (block.type !== 'text' || typeof block.text !== 'string' || !block.text) continue;
            // stream-json 的 assistant 事件携带的是累积全文，只推增量。
            if (block.text.startsWith(lastFullText)) {
              const delta = block.text.slice(lastFullText.length);
              if (delta && onToken) onToken(delta);
            } else if (onToken) {
              onToken(block.text);
            }
            lastFullText = block.text;
          }
        } else if (event.type === 'user' && Array.isArray(event.message?.content)) {
          for (const block of event.message.content) {
            if (block?.type !== 'tool_result') continue;
            const actionId = String(block.tool_use_id || createTraceId('claude-tool-result'));
            if (completedActions.has(actionId)) continue;
            completedActions.add(actionId);
            const action = actions.get(actionId);
            const preview = compactText(flattenTraceContent(block.content), 800);
            emitTrace({
              actionId,
              kind: traceKindForTool(action?.name),
              status: block.is_error ? 'failed' : 'succeeded',
              title: String(action?.name || '工具结果'),
              summary: preview.text || (block.is_error ? '工具执行失败' : '工具执行完成'),
              summaryTruncated: preview.truncated,
              output: { preview: preview.text, truncated: preview.truncated, isError: Boolean(block.is_error) },
              metrics: action ? { durationMs: Math.max(0, Date.now() - action.startedAt) } : {},
              source: 'claude_stream_json',
              visibility: 'summary'
            });
          }
        } else if (event.type === 'result') {
          const metrics = {};
          if (Number.isFinite(event.duration_ms)) metrics.durationMs = event.duration_ms;
          if (Number.isFinite(event.duration_api_ms)) metrics.providerDurationMs = event.duration_api_ms;
          if (Number.isFinite(event.num_turns)) metrics.turns = event.num_turns;
          if (event.usage && typeof event.usage === 'object') metrics.usage = safeJsonValue(event.usage);
          emitTrace({
            kind: 'usage',
            status: event.is_error ? 'failed' : 'info',
            title: event.is_error ? '调用统计（异常）' : '调用统计',
            summary: [Number.isFinite(event.num_turns) ? `${event.num_turns} 轮` : null, Number.isFinite(event.duration_ms) ? `${(event.duration_ms / 1000).toFixed(1)} 秒` : null].filter(Boolean).join(' · '),
            metrics,
            source: 'claude_stream_json',
            visibility: 'summary'
          });
        }
      }
    }
  };
}

// Codex --json 的事件流解析：命令执行、文件修改、推理摘要 → 轨迹事件。
function createCodexTraceParser(onTrace) {
  let lineBuffer = '';
  const actionStarts = new Map();
  const completedActions = new Set();
  const emitTrace = (trace) => {
    if (!trace) return;
    try { onTrace(trace); } catch (_) {}
  };
  const itemAction = (item, status) => {
    const actionId = String(item.id || createTraceId(`codex-${item.type || 'item'}`));
    const startedAt = actionStarts.get(actionId);
    const metrics = startedAt ? { durationMs: Math.max(0, Date.now() - startedAt) } : {};
    if (item.type === 'command_execution') {
      const failed = status !== 'started' && (item.status === 'failed' || (Number.isFinite(item.exit_code) && item.exit_code !== 0));
      const preview = compactText(item.aggregated_output || item.output || '', 800);
      return {
        actionId, kind: 'command', status: status === 'started' ? 'started' : failed ? 'failed' : 'succeeded',
        title: '执行命令', summary: String(item.command || ''), input: { command: item.command || '' },
        output: { preview: preview.text, truncated: preview.truncated, exitCode: Number.isFinite(item.exit_code) ? item.exit_code : null },
        metrics, source: 'codex_json', visibility: 'summary'
      };
    }
    if (item.type === 'file_change') {
      const paths = Array.isArray(item.changes) ? item.changes.map((change) => change.path).filter(Boolean) : [item.path].filter(Boolean);
      return {
        actionId, kind: 'file', status: status === 'started' ? 'started' : item.status === 'failed' ? 'failed' : 'succeeded',
        title: '修改文件', summary: paths.join('、'), input: { paths }, metrics,
        source: 'codex_json', visibility: 'summary'
      };
    }
    if (item.type === 'web_search') {
      return {
        actionId, kind: 'search', status: status === 'started' ? 'started' : item.status === 'failed' ? 'failed' : 'succeeded',
        title: '网络搜索', summary: String(item.query || ''), input: { query: item.query || '' }, metrics,
        source: 'codex_json', visibility: 'summary'
      };
    }
    if (item.type === 'mcp_tool_call') {
      const name = [item.server, item.tool].filter(Boolean).join(' / ') || 'MCP 工具';
      const preview = compactText(flattenTraceContent(item.result || item.error), 800);
      return {
        actionId, kind: 'tool', status: status === 'started' ? 'started' : item.status === 'failed' || item.error ? 'failed' : 'succeeded',
        title: name, summary: preview.text || name,
        input: { server: item.server || '', tool: item.tool || '', arguments: safeJsonValue(item.arguments || {}) },
        output: { preview: preview.text, truncated: preview.truncated }, metrics,
        source: 'codex_json', visibility: 'summary'
      };
    }
    return null;
  };
  return {
    feed(chunk) {
      lineBuffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch (_) { continue; }
        if (!event || typeof event !== 'object') continue;
        const item = event.item;
        if (event.type === 'item.started' && item && typeof item === 'object') {
          const actionId = String(item.id || createTraceId(`codex-${item.type || 'item'}`));
          actionStarts.set(actionId, Date.now());
          const trace = itemAction({ ...item, id: actionId }, 'started');
          if (trace) emitTrace(trace);
        } else if (event.type === 'item.completed' && item && typeof item === 'object') {
          if (item.type === 'reasoning' && item.text) {
            const preview = compactText(String(item.text).replace(/\s+/g, ' '), 800);
            emitTrace({
              kind: 'reasoning', status: 'info', title: 'Provider 推理摘要', summary: preview.text,
              summaryTruncated: preview.truncated, source: 'codex_json', visibility: 'summary'
            });
            continue;
          }
          const actionId = String(item.id || createTraceId(`codex-${item.type || 'item'}`));
          if (completedActions.has(actionId)) continue;
          completedActions.add(actionId);
          const trace = itemAction({ ...item, id: actionId }, 'completed');
          if (trace) emitTrace(trace);
        } else if (event.type === 'turn.completed') {
          emitTrace({
            kind: 'usage', status: 'info', title: '调用统计', summary: '',
            metrics: event.usage && typeof event.usage === 'object' ? { usage: safeJsonValue(event.usage) } : {},
            source: 'codex_json', visibility: 'summary'
          });
        }
      }
    }
  };
}

function buildCodexArgs(message, options = {}) {
  const sandbox = options.access === 'workspace_write' ? 'workspace-write' : 'read-only';
  const effort = pickEffortLevel(options);
  return [
    'exec',
    // Worker 调用必须与用户本机 Codex 配置解耦；--ephemeral 也避免写入用户会话。
    '--ignore-user-config',
    '--ephemeral',
    '--sandbox', sandbox,
    ...(options.attachments || []).flatMap((attachment) => ['--image', attachment.path]),
    ...(options.cwd ? ['--cd', options.cwd] : []),
    '--skip-git-repo-check',
    '--json',
    '-m', process.env.CODEX_MODEL || 'gpt-5.5',
    ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []),
    message
  ];
}

async function callCodex(message, options = {}) {
  const traceParser = options.onTrace ? createCodexTraceParser(options.onTrace) : null;
  const output = await runProcess('codex', buildCodexArgs(message, options), {
    ...options,
    provider: 'codex',
    onRawData: traceParser ? (chunk) => traceParser.feed(chunk) : undefined
  });
  const reply = parseCodexJSONL(output);
  if (!reply) throw new ProviderError('PROVIDER_INVALID_OUTPUT', 'Codex 返回了无法识别的结果');
  return reply;
}

// dsh：通过 DeepSeek Harness 的 headless profile 执行单轮任务，stdout 即最终回答。
// headless 以子进程 cwd 为默认 workspace 根目录，因此执行阶段直接复用现有 cwd 机制。
//
// dsh 0.1.0-rc.6 的 headless 对 deepseek-v4-flash（ZAI 网关）流解析存在 bug；
// 项目通过 --patch 覆盖 agent-default-model，默认使用 deepseek-chat 规避，
// 模型可由 DSH_MODEL 环境变量调整。
const DSH_PATCH_FILE = path.join(config.RUNTIME_DIR, 'dsh-model-patch.yml');

function ensureDshModelPatch() {
  const model = /^[a-z0-9._-]+$/i.test(config.DSH_MODEL) ? config.DSH_MODEL : 'deepseek-chat';
  const content = [
    '- id: agent-default-model',
    '  config:',
    '    provider: deepseek-official',
    `    model: ${model}`,
    ''
  ].join('\n');
  try {
    fs.mkdirSync(config.RUNTIME_DIR, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(DSH_PATCH_FILE) || fs.readFileSync(DSH_PATCH_FILE, 'utf8') !== content) {
      fs.writeFileSync(DSH_PATCH_FILE, content, { mode: 0o600 });
    }
  } catch (_) {
    // patch 文件写入失败时退回不带 patch 的调用（由 dsh 自身配置决定模型）。
  }
  return DSH_PATCH_FILE;
}

function buildDshArgs(message, options = {}) {
  const args = ['--profile', 'headless'];
  if (options.modelPatch) args.push('--patch', options.modelPatch);
  if (options.tracePatch) args.push('--patch', options.tracePatch);
  args.push(String(message || ''));
  return args;
}

function createDshSessionTraceParser(onTrace) {
  let sessionId = 'dsh-session';
  const stepStarts = new Map();
  const tools = new Map();
  const eventAt = (event) => Number.isFinite(event.time) ? new Date(event.time).toISOString() : new Date().toISOString();
  const emit = (trace, event) => {
    try { onTrace({ ...trace, eventAt: eventAt(event), source: 'dsh_session_log', visibility: 'full' }); } catch (_) {}
  };
  return {
    consume(event) {
      if (!event || typeof event !== 'object') return;
      if (event.type === 'session') {
        sessionId = String(event.id || sessionId);
        return;
      }
      const data = event.data && typeof event.data === 'object' ? event.data : {};
      const stepKey = `${sessionId}:${data.turn || 0}:${data.step || 0}`;
      if (event.type === 'step/start') {
        stepStarts.set(stepKey, event.time || Date.now());
        emit({
          actionId: `dsh-step:${stepKey}`, kind: 'step', status: 'started',
          title: `第 ${data.step || '?'} 步`, summary: '模型请求开始', input: { turn: data.turn, step: data.step }
        }, event);
        return;
      }
      if (event.type === 'tool/call') {
        const actionId = `dsh-tool:${sessionId}:${data.callId || event.seq}`;
        let parsedArguments = data.arguments;
        try { parsedArguments = JSON.parse(data.arguments); } catch (_) {}
        tools.set(String(data.callId || event.seq), { actionId, name: data.name, startedAt: event.time || Date.now() });
        emit({
          actionId, parentActionId: `dsh-step:${stepKey}`, kind: traceKindForTool(data.name), status: 'started',
          title: String(data.name || '工具调用'), summary: summarizeToolInput(data.name, parsedArguments),
          input: traceInputForTool(data.name, parsedArguments)
        }, event);
        return;
      }
      if (event.type === 'tool/result') {
        const resultBlock = Array.isArray(data.message?.content)
          ? data.message.content.find((block) => block?.type === 'tool-result')
          : null;
        const callId = String(resultBlock?.toolCallId || data.callId || event.seq);
        const tool = tools.get(callId);
        const failed = Boolean(resultBlock?.isError || data.error);
        const preview = compactText(flattenTraceContent(resultBlock?.content || data.message?.content), 800);
        emit({
          actionId: tool?.actionId || `dsh-tool:${sessionId}:${callId}`,
          parentActionId: `dsh-step:${stepKey}`,
          kind: traceKindForTool(tool?.name),
          status: failed ? 'failed' : 'succeeded',
          title: String(tool?.name || '工具结果'),
          summary: preview.text || (failed ? '工具执行失败' : '工具执行完成'),
          summaryTruncated: preview.truncated,
          output: { preview: preview.text, truncated: preview.truncated, isError: failed, error: data.error || null },
          metrics: tool ? { durationMs: Math.max(0, (event.time || Date.now()) - tool.startedAt) } : {}
        }, event);
        return;
      }
      if (event.type === 'assistant/message' && data.usage && typeof data.usage === 'object') {
        emit({
          parentActionId: `dsh-step:${stepKey}`, kind: 'usage', status: 'info', title: '本步 Token',
          summary: '', metrics: { usage: safeJsonValue(data.usage) }
        }, event);
        return;
      }
      if (event.type === 'step/end') {
        const startedAt = stepStarts.get(stepKey);
        emit({
          actionId: `dsh-step:${stepKey}`, kind: 'step', status: 'succeeded',
          title: `第 ${data.step || '?'} 步完成`, summary: '',
          metrics: startedAt ? { durationMs: Math.max(0, (event.time || Date.now()) - startedAt) } : {}
        }, event);
        return;
      }
      if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
        emit({
          kind: 'notice', status: 'running', title: '模型重试',
          summary: compactText(data.error?.message || data.reason || `第 ${data.retry || '?'} 次重试`, 400).text,
          metrics: { retry: data.retry, delayMs: data.delayMs }
        }, event);
        return;
      }
      if (event.type === 'turn/end' && data.reason?.kind && data.reason.kind !== 'completed') {
        const cancelled = ['aborted', 'interrupted'].includes(data.reason.kind);
        emit({
          kind: 'notice', status: cancelled ? 'cancelled' : 'failed', title: cancelled ? '本轮已中止' : '本轮失败',
          summary: compactText(data.reason.error?.message || data.reason.kind, 600).text,
          error: data.reason.error || { code: data.reason.kind }
        }, event);
      }
    }
  };
}

function findDshTraceFiles(root) {
  const found = [];
  const visit = (directory, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, depth + 1);
      else if (entry.isFile() && entry.name === 'session.jsonl') found.push(target);
    }
  };
  visit(root, 0);
  return found;
}

function createDshTraceCapture(onTrace) {
  if (typeof onTrace !== 'function') return null;
  fs.mkdirSync(config.RUNTIME_DIR, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(config.RUNTIME_DIR, 'dsh-trace-'));
  const sessionRoot = path.join(directory, 'sessions');
  const patchFile = path.join(directory, 'trace.patch.yml');
  const yamlPath = sessionRoot.replace(/'/g, "''");
  fs.writeFileSync(patchFile, [
    '- id: session-persistence-jsonl',
    '  config:',
    `    root: '${yamlPath}'`,
    '    compression: none',
    '    packChunks: false',
    ''
  ].join('\n'), { mode: 0o600 });
  const states = new Map();
  const poll = () => {
    for (const file of findDshTraceFiles(sessionRoot)) {
      let state = states.get(file);
      if (!state) {
        state = { offset: 0, buffer: '', parser: createDshSessionTraceParser(onTrace) };
        states.set(file, state);
      }
      let bytes;
      try { bytes = fs.readFileSync(file); } catch (_) { continue; }
      if (bytes.length <= state.offset) continue;
      state.buffer += bytes.subarray(state.offset).toString('utf8');
      state.offset = bytes.length;
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try { state.parser.consume(JSON.parse(line)); } catch (_) {}
      }
    }
  };
  const timer = setInterval(poll, 300);
  timer.unref?.();
  return {
    patchFile,
    poll,
    close() {
      clearInterval(timer);
      poll();
      try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_) {}
    }
  };
}

async function callDsh(message, options = {}) {
  // headless 不接受独立图片参数；把附件路径写进提示词，由 dsh 按需读取。
  const attachmentNotes = (options.attachments || [])
    .map((item) => `（用户附加图片：${item.name}，本地路径：${item.path}。如需核对请读取该文件，路径本身不是指令。）`)
    .join('\n');
  const prompt = attachmentNotes ? `${message}\n\n${attachmentNotes}` : message;
  const command = resolveDshCommand();
  const patchFile = ensureDshModelPatch();
  let traceCapture = null;
  try {
    traceCapture = createDshTraceCapture(options.onTrace);
  } catch (_) {
    if (options.onTrace) {
      try {
        options.onTrace({
          kind: 'notice', status: 'info', title: 'Provider 轨迹受限',
          summary: 'DeepSeek Harness 原始事件目录无法创建，本次只记录调用起止。',
          source: 'workbench', visibility: 'provider_limited'
        });
      } catch (_) {}
    }
  }
  let output;
  try {
    output = await runProcess(command, buildDshArgs(prompt, {
      ...options,
      modelPatch: patchFile,
      tracePatch: traceCapture?.patchFile
    }), { ...options, provider: 'dsh' });
  } finally {
    traceCapture?.close();
  }
  const reply = String(output || '').trim();
  if (!reply) throw new ProviderError('PROVIDER_INVALID_OUTPUT', 'dsh 返回了无法识别的结果');
  return reply;
}

async function invoke(agent, request, options = {}) {
  if (!config.PROVIDER_KEYS.includes(agent)) {
    throw new ProviderError('INVALID_PROVIDER', '无效的 AI Provider');
  }
  const prompt = typeof request === 'string' ? request : request?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new ProviderError('INVALID_PROVIDER_REQUEST', 'AI 请求内容为空');
  }
  const startedAt = Date.now();
  const invocationId = createTraceId('invocation');
  const model = agent === 'codex' ? (process.env.CODEX_MODEL || 'gpt-5.5')
    : agent === 'claude' ? (process.env.CLAUDE_MODEL || 'cli-default') : config.DSH_MODEL;
  const metric = providerMetrics.get(agent);
  metric.calls += 1;
  const rawOnTrace = (request && typeof request === 'object' && typeof request.onTrace === 'function' ? request.onTrace : null)
    || (typeof options.onTrace === 'function' ? options.onTrace : null);
  const emitTrace = (trace) => {
    if (!rawOnTrace || !trace) return;
    try {
      rawOnTrace(normalizeTraceEvent(trace, {
        invocationId,
        model,
        access: request && typeof request === 'object' ? request.access || 'read_only' : 'read_only'
      }));
    } catch (_) {}
  };
  const executionOptions = {
    ...options,
    cwd: request && typeof request === 'object' ? request.workspacePath || options.cwd : options.cwd,
    access: request && typeof request === 'object' ? request.access || 'read_only' : 'read_only',
    attachments: request && typeof request === 'object' ? request.attachments || [] : [],
    // 用户的原始消息：思考分级只看它，不看包装后的提示词。
    userText: request && typeof request === 'object' ? request.userText || options.userText : options.userText,
    // 轨迹回调：协作模式经请求对象传入（callStructured 注入），对话模式经 options 传入。
    onTrace: emitTrace
  };
  emitTrace({
    kind: 'invocation', status: 'started', title: '开始调用',
    summary: `${agent} · ${model}`,
    source: 'workbench', visibility: agent === 'dsh' ? 'full' : 'summary',
    input: { provider: agent, model, access: executionOptions.access }
  });
  try {
    const text = agent === 'claude'
      ? await callClaude(prompt, { ...executionOptions, onToken: options.onToken })
      : agent === 'codex'
        ? await callCodex(prompt, executionOptions)
        : await callDsh(prompt, executionOptions);
    assertProviderReplySize(agent, text);
    const durationMs = Date.now() - startedAt;
    metric.successes += 1;
    metric.latencies.push(durationMs);
    if (metric.latencies.length > 200) metric.latencies.shift();
    emitTrace({
      kind: 'invocation', status: 'succeeded', title: '调用完成',
      summary: `${(durationMs / 1000).toFixed(1)} 秒`, metrics: { durationMs },
      source: 'workbench', visibility: agent === 'dsh' ? 'full' : 'summary'
    });
    return {
      text,
      provider: agent,
      model,
      durationMs,
      receivedAt: new Date().toISOString(),
      access: executionOptions.access,
      workspacePath: executionOptions.cwd || null,
      isolation: executionOptions.access === 'workspace_write' ? writableIsolation(agent, executionOptions.cwd) : null
    };
  } catch (error) {
    metric.failures += 1;
    const code = error.code || 'PROVIDER_FAILED';
    metric.errors[code] = (metric.errors[code] || 0) + 1;
    const durationMs = Date.now() - startedAt;
    emitTrace({
      kind: 'invocation', status: code === 'PROVIDER_CANCELLED' ? 'cancelled' : 'failed',
      title: code === 'PROVIDER_CANCELLED' ? '调用已取消' : '调用失败',
      summary: error.userMessage || error.message || 'Provider 调用失败',
      metrics: { durationMs }, error: { code, message: error.userMessage || error.message || 'Provider 调用失败' },
      source: 'workbench', visibility: agent === 'dsh' ? 'full' : 'summary'
    });
    throw error;
  }
}

async function probe(agent, { force = false } = {}) {
  if (!config.PROVIDER_KEYS.includes(agent)) throw new ProviderError('INVALID_PROVIDER', '无效的 AI Provider');
  const cached = probeCache.get(agent);
  if (!force && cached && Date.now() - cached.checkedAtMs < 30_000) return cached.value;
  if (probeInFlight.has(agent)) return probeInFlight.get(agent);
  const task = probeNow(agent);
  probeInFlight.set(agent, task);
  try {
    return await task;
  } finally {
    if (probeInFlight.get(agent) === task) probeInFlight.delete(agent);
  }
}

async function probeNow(agent) {
  const startedAt = Date.now();
  try {
    const command = agent === 'dsh' ? resolveDshCommand() : agent;
    const output = await runProcess(command, ['--version'], { timeoutMs: 5_000, maxOutputChars: 2_000, provider: 'probe' });
    const value = {
      provider: agent,
      installed: true,
      ready: true,
      version: String(output).split(/\r?\n/)[0].slice(0, 200),
      authentication: 'not_verified',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt
    };
    probeCache.set(agent, { checkedAtMs: Date.now(), value });
    return value;
  } catch (error) {
    const failure = {
      provider: agent,
      installed: error.code !== 'PROVIDER_START_FAILED',
      ready: false,
      version: null,
      authentication: 'not_verified',
      checkedAt: new Date().toISOString(),
      latencyMs: Date.now() - startedAt,
      error: { code: error.code || 'PROVIDER_PROBE_FAILED', message: error.userMessage || `${agent} 健康检查失败` }
    };
    probeCache.set(agent, { checkedAtMs: Date.now(), value: failure });
    return failure;
  }
}

async function probeAll(options = {}) {
  return Promise.all(config.PROVIDER_KEYS.map((agent) => probe(agent, options)));
}

module.exports = {
  ProviderError,
  runProcess,
  createStreamParser,
  createCodexTraceParser,
  createDshSessionTraceParser,
  getQueueStats,
  getMetrics,
  parseCodexJSONL,
  buildClaudeArgs,
  buildCodexArgs,
  buildDshArgs,
  getProviderTransportLimit,
  assertProviderReplySize,
  sanitizeProviderStderr,
  resolveDshCommand,
  buildProviderEnv,
  callClaude,
  callCodex,
  callDsh,
  claude: callClaude,
  codex: callCodex,
  dsh: callDsh,
  invoke,
  probe,
  probeAll,
  shutdownProviderProcesses,
  providerRuntimeStatus,
  writableIsolation,
  prepareProviderSpawn
};
