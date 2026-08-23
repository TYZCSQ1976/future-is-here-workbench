const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCodexJSONL,
  buildProviderEnv,
  buildClaudeArgs,
  buildCodexArgs,
  buildDshArgs,
  getProviderTransportLimit,
  assertProviderReplySize,
  getQueueStats,
  getMetrics,
  claude,
  codex,
  dsh,
  invoke
} = require('../src/providers');

test('Codex JSONL 解析只提取完成的 agent message', () => {
  const output = [
    JSON.stringify({ type: 'thread.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '内部推理' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '最终方案' } })
  ].join('\n');
  assert.equal(parseCodexJSONL(output), '最终方案');
  const multiMessageOutput = [
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '我先检查一下项目。' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '这是检查完成后的最终答复。' } })
  ].join('\n');
  assert.equal(parseCodexJSONL(multiMessageOutput), '这是检查完成后的最终答复。');
  assert.equal(parseCodexJSONL('不是 JSON'), '');
});

test('Provider 导出服务端需要的统一接口，并过滤无关环境变量', () => {
  assert.equal(typeof claude, 'function');
  assert.equal(typeof codex, 'function');
  assert.equal(typeof dsh, 'function');
  assert.equal(typeof invoke, 'function');
  assert.equal(getQueueStats().active, 0);
  assert.equal(getQueueStats().queued, 0);
  assert.ok(getQueueStats().limit >= 1);
  assert.deepEqual(Object.keys(getMetrics()).sort(), ['claude', 'codex', 'dsh']);
  const source = {
    PATH: '/usr/bin',
    OPENAI_API_KEY: 'intended-provider-secret',
    ANTHROPIC_API_KEY: 'claude-secret',
    DATABASE_PASSWORD: 'must-not-leak',
    PROVIDER_ENV_ALLOWLIST_EXTRA_CODEX: 'CUSTOM_PROVIDER_TOKEN',
    CUSTOM_PROVIDER_TOKEN: 'allowed-explicitly'
  };
  const env = buildProviderEnv('codex', source);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OPENAI_API_KEY, 'intended-provider-secret');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CUSTOM_PROVIDER_TOKEN, 'allowed-explicitly');
  assert.equal(env.DATABASE_PASSWORD, undefined);
  assert.equal(buildProviderEnv('claude', source).OPENAI_API_KEY, undefined);
  assert.equal(buildProviderEnv('probe', source).OPENAI_API_KEY, undefined);
});

test('dsh 使用 headless profile 单轮调用，并保留 DSH_HOME 与显式白名单', () => {
  // 不带 patch 时只含启动器参数与任务文本；带 patch 时按启动器规则置于任务文本之前。
  assert.deepEqual(buildDshArgs('帮我检查一下项目'), ['--profile', 'headless', '帮我检查一下项目']);
  assert.deepEqual(buildDshArgs('帮我检查一下项目', { modelPatch: '/tmp/dsh-patch.yml' }),
    ['--profile', 'headless', '--patch', '/tmp/dsh-patch.yml', '帮我检查一下项目']);
  const source = {
    PATH: '/usr/bin',
    DSH_HOME: '/Users/taiyang/.dsh',
    DSH_SESSION_JSONL: 'parent-session-must-not-leak',
    PROVIDER_ENV_ALLOWLIST_EXTRA_DSH: 'MY_DSH_FLAG',
    MY_DSH_FLAG: '1'
  };
  const env = buildProviderEnv('dsh', source);
  assert.equal(env.DSH_HOME, '/Users/taiyang/.dsh');
  assert.equal(env.MY_DSH_FLAG, '1');
  assert.equal(env.DSH_SESSION_JSONL, undefined);
  // claude/codex 凭据不会进入 dsh 环境。
  const mixed = { ...source, ANTHROPIC_API_KEY: 'claude-secret', OPENAI_API_KEY: 'codex-secret' };
  const dshEnv = buildProviderEnv('dsh', mixed);
  assert.equal(dshEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(dshEnv.OPENAI_API_KEY, undefined);
});

test('真实执行与讨论使用不同的 CLI 沙箱权限和工作目录', () => {
  assert.deepEqual(buildClaudeArgs('执行', { access: 'workspace_write' }).slice(0, 7), ['-p', '执行', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.match(buildClaudeArgs('执行', { access: 'workspace_write' }).join(' '), /--tools Read,Edit,Write,Glob,Grep,Bash/);
  assert.match(buildClaudeArgs('讨论', { access: 'read_only' }).join(' '), /--permission-mode plan/);
  const chatArgs = buildClaudeArgs('讨论', { access: 'read_only', phase: 'answer' });
  assert.match(chatArgs.join(' '), /--output-format stream-json --verbose/);
  assert.equal(chatArgs[chatArgs.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.doesNotMatch(chatArgs.join(' '), /Edit|Write|Bash/);
  assert.match(buildClaudeArgs('聊天', { access: 'read_only', phase: 'answer' }).join(' '), /--setting-sources project/);
  assert.match(buildClaudeArgs('聊天', { access: 'read_only', phase: 'answer' }).join(' '), /--append-system-prompt .{0,20}未来已来/);
  assert.match(buildClaudeArgs('聊天', { access: 'read_only', phase: 'answer', userText: '你好' }).join(' '), /--effort low/);
  assert.doesNotMatch(buildClaudeArgs('请分析这段代码的报错原因并修复', { access: 'read_only', phase: 'answer', userText: '请分析这段代码的报错原因并修复' }).join(' '), /--effort/);
  const collaborationArgs = buildClaudeArgs('协作发言', { access: 'read_only', phase: 'collaboration' });
  assert.equal(collaborationArgs[collaborationArgs.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.doesNotMatch(collaborationArgs.join(' '), /--effort/);
  assert.match(buildClaudeArgs('看图', { access: 'read_only', phase: 'answer', attachments: [{ path: '/tmp/a.png' }] }).join(' '), /--tools Read/);
  assert.match(buildClaudeArgs('执行', { access: 'workspace_write', phase: 'execute' }).join(' '), /--effort high/);
  const writeArgs = buildCodexArgs('执行', { access: 'workspace_write', cwd: '/tmp/project' });
  assert.deepEqual(writeArgs.slice(0, 6), ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'workspace-write', '--cd']);
  assert.equal(writeArgs[6], '/tmp/project');
  assert.equal(writeArgs[7], '--skip-git-repo-check');
  assert.match(writeArgs.join(' '), /-m gpt-5\.5/);
  assert.match(buildCodexArgs('复核', { access: 'read_only' }).join(' '), /--sandbox read-only/);
  assert.doesNotMatch(writeArgs.join(' '), /dangerously/);
});

test('可写 Provider 必须具备工作台可验证的隔离，DeepSeek 安全降级为只读成员', () => {
  const { writableIsolation, prepareProviderSpawn } = require('../src/providers');
  const root = process.cwd();
  assert.equal(writableIsolation('codex', root).enforced, true);
  assert.equal(writableIsolation('dsh', root).enforced, false);
  assert.throws(
    () => prepareProviderSpawn('dsh', ['任务'], { provider: 'dsh', access: 'workspace_write', cwd: root }),
    (error) => error.code === 'PROVIDER_WRITE_SANDBOX_UNAVAILABLE'
  );
  const codexSpec = prepareProviderSpawn('codex', ['exec'], { provider: 'codex', access: 'workspace_write', cwd: root });
  assert.equal(codexSpec.command, 'codex');
  if (process.platform === 'darwin') {
    const claudeSpec = prepareProviderSpawn('claude', ['-p', '任务'], { provider: 'claude', access: 'workspace_write', cwd: root });
    assert.equal(claudeSpec.command, '/usr/bin/sandbox-exec');
    assert.match(claudeSpec.args[1], /deny file-write/);
    require('node:fs').rmSync(claudeSpec.tempPath, { recursive: true, force: true });
  }
});

test('结构化 CLI 的传输包装限额与最终回答限额分离', () => {
  // Codex/Claude 的 JSONL 会附带事件元数据；包装大不代表最终回答大。
  assert.ok(getProviderTransportLimit('codex') > getProviderTransportLimit('dsh'));
  assert.doesNotThrow(() => assertProviderReplySize('codex', '可用回答'));
  assert.throws(
    () => assertProviderReplySize('codex', 'x'.repeat(120_001)),
    (error) => error.code === 'PROVIDER_OUTPUT_TOO_LARGE'
  );
});

test('execute/verify 阶段按权限开放工具，不再被当作纯讨论', () => {
  // 主笔执行阶段：必须拥有完整写工具，且不降低思考强度（B2 回归）。
  const executeArgs = buildClaudeArgs('执行方案', { access: 'workspace_write', phase: 'execute' });
  assert.match(executeArgs.join(' '), /--tools Read,Edit,Write,Glob,Grep,Bash/);
  assert.match(executeArgs.join(' '), /--effort high/);
  // 独立验证阶段：只读检查工具，不带 Bash，也不降低思考强度。
  const verifyArgs = buildClaudeArgs('验证产物', { access: 'read_only', phase: 'verify' });
  assert.match(verifyArgs.join(' '), /--tools Read,Glob,Grep/);
  assert.doesNotMatch(verifyArgs.join(' '), /Edit|Write|Bash/);
  assert.doesNotMatch(verifyArgs.join(' '), /--effort/);
  assert.match(verifyArgs.join(' '), /--permission-mode plan/);
  // 纯讨论阶段拥有只读工具（能看文件），思考强度用 CLI 默认档，但不能修改。
  const discussionArgs = buildClaudeArgs('讨论发言', { access: 'read_only', phase: 'collaboration' });
  assert.equal(discussionArgs[discussionArgs.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.doesNotMatch(discussionArgs.join(' '), /--effort/);
  // 修复轮把 execute 阶段降级为只读，思考强度回到默认档。
  const repairArgs = buildClaudeArgs('修复格式', { access: 'read_only', phase: 'execute' });
  assert.doesNotMatch(repairArgs.join(' '), /--effort/);
});

test('传输大小与最终回答长度分离：JSONL 中间过程不算最终长度', () => {
  // JSONL 传输包装限制（claude/codex 8MB）与最终文本限制（120K）是两套上限。
  assert.equal(getProviderTransportLimit('codex'), 8 * 1024 * 1024);
  assert.equal(getProviderTransportLimit('claude'), 8 * 1024 * 1024);
  assert.equal(getProviderTransportLimit('dsh'), 120_000);
  // 中间大量 reasoning/tool 事件不影响最终回答长度校验。
  const reasoning = JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'x'.repeat(90_000) } });
  const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '短回答' } });
  const parsed = parseCodexJSONL(`${reasoning}\n${message}`);
  assert.equal(parsed, '短回答');
  assert.doesNotThrow(() => assertProviderReplySize('codex', parsed));
  assert.throws(() => assertProviderReplySize('codex', '长'.repeat(120_001)), /最终回答过长/);
});

test('错误信息脱敏：stderr 中的令牌与 Bearer 不会直接展示', () => {
  const { sanitizeProviderStderr } = require('../src/providers');
  const dirty = 'API_KEY=sk-1234567890\nBearer abc.def.ghi\nAuthorization: Bearer xyz\n普通错误信息';
  const clean = sanitizeProviderStderr(dirty);
  assert.doesNotMatch(clean, /sk-1234567890/);
  assert.doesNotMatch(clean, /abc\.def\.ghi/);
  assert.doesNotMatch(clean, /xyz/);
  assert.match(clean, /普通错误信息/);
});

test('命令不存在时给出可操作的 ENOENT 提示（不再只说“暂时无法启动”）', async () => {
  const { runProcess, ProviderError } = require('../src/providers');
  await assert.rejects(
    () => runProcess('definitely-not-a-real-command-xyz-123', [], { provider: 'probe' }),
    (error) => {
      assert.equal(error instanceof ProviderError, true);
      assert.equal(error.code, 'PROVIDER_START_FAILED');
      assert.match(error.userMessage, /找不到命令/);
      assert.match(error.userMessage, /DSH_CLI_PATH|PATH/);
      return true;
    }
  );
});

test('子进程超时进入可恢复的 PROVIDER_TIMEOUT', async () => {
  const { runProcess, ProviderError } = require('../src/providers');
  await assert.rejects(
    () => runProcess('sleep', ['5'], { timeoutMs: 400, provider: 'probe' }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_TIMEOUT');
      assert.match(error.userMessage, /响应超时/);
      return true;
    }
  );
});

test('传输数据超过上限时安全中断（与最终回答长度无关）', async () => {
  const { runProcess, ProviderError } = require('../src/providers');
  await assert.rejects(
    () => runProcess('yes', [], { provider: 'probe', maxOutputChars: 2_048, timeoutMs: 8_000 }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_OUTPUT_TOO_LARGE');
      assert.match(error.userMessage, /传输数据超过/);
      return true;
    }
  );
});

test('dsh 命令可以自动定位到 npx 缓存（服务进程 PATH 缺 npx 目录时）', () => {
  const { resolveDshCommand } = require('../src/providers');
  const resolved = resolveDshCommand();
  assert.ok(resolved, '应解析出 dsh 命令');
  assert.match(resolved, /dsh$/);
});

test('终止信号下子进程中止被分类为“已取消”而非“无法启动”', async () => {
  const { runProcess, ProviderError } = require('../src/providers');
  const controller = new AbortController();
  const promise = runProcess('sleep', ['30'], { provider: 'probe', signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof ProviderError, true);
    assert.equal(error.code, 'PROVIDER_CANCELLED');
    assert.match(error.userMessage, /已取消/);
    return true;
  });
});

test('轨迹解析：claude 工具调用与统计、codex 过程事件都能成为轨迹', () => {
  const { createStreamParser, createCodexTraceParser } = require('../src/providers');
  const traces = [];
  const tokens = [];
  const parser = createStreamParser((t) => tokens.push(t), (trace) => traces.push(trace));
  // 模拟 stream-json：assistant 里带 tool_use，结尾带 result 统计。
  parser.feed(Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'tool-read-1', name: 'Read', input: { file_path: '/tmp/long/path/src/config.js' } },
    { type: 'text', text: '第一段' }
  ] } }) + '\n'));
  parser.feed(Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'text', text: '第一段第二段' }
  ] } }) + '\n'));
  parser.feed(Buffer.from(JSON.stringify({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'tool-read-1', content: '文件内容', is_error: false }
  ] } }) + '\n'));
  parser.feed(Buffer.from(JSON.stringify({ type: 'result', duration_ms: 8200, num_turns: 2, usage: { input_tokens: 12, output_tokens: 5 } }) + '\n'));
  assert.deepEqual(tokens, ['第一段', '第二段']);
  assert.equal(traces.length, 3);
  assert.equal(traces[0].kind, 'read');
  assert.equal(traces[0].status, 'started');
  assert.match(traces[0].title, /Read/);
  assert.match(traces[0].summary, /config\.js/);
  assert.equal(traces[1].status, 'succeeded');
  assert.match(traces[1].output.preview, /文件内容/);
  assert.equal(traces[2].kind, 'usage');
  assert.match(traces[2].summary, /2 轮/);

  const codexTraces = [];
  const codexParser = createCodexTraceParser((trace) => codexTraces.push(trace));
  codexParser.feed(Buffer.from(JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test' } }) + '\n'));
  codexParser.feed(Buffer.from(JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'npm test', aggregated_output: '12 tests passed', exit_code: 0 } }) + '\n'));
  codexParser.feed(Buffer.from(JSON.stringify({ type: 'item.completed', item: { id: 'file-1', type: 'file_change', changes: [{ path: 'src/a.js' }] } }) + '\n'));
  codexParser.feed(Buffer.from(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 10 } }) + '\n'));
  codexParser.feed(Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '最终回答' } }) + '\n'));
  assert.equal(codexTraces.length, 4);
  assert.equal(codexTraces[0].kind, 'command');
  assert.equal(codexTraces[0].status, 'started');
  assert.match(codexTraces[0].summary, /npm test/);
  assert.equal(codexTraces[1].status, 'succeeded');
  assert.equal(codexTraces[1].output.exitCode, 0);
  assert.match(codexTraces[1].output.preview, /12 tests passed/);
  assert.equal(codexTraces[2].kind, 'file');
  assert.equal(codexTraces[3].kind, 'usage');
});

test('DeepSeek Harness 原始会话日志会还原步骤、工具结果、用量与失败终态', () => {
  const { createDshSessionTraceParser } = require('../src/providers');
  const traces = [];
  const parser = createDshSessionTraceParser((trace) => traces.push(trace));
  parser.consume({ type: 'session', id: 'session-1' });
  parser.consume({ type: 'step/start', seq: 2, time: 1_000, data: { turn: 1, step: 1 } });
  parser.consume({ type: 'tool/call', seq: 4, time: 1_100, data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"npm test"}' } });
  parser.consume({ type: 'tool/result', seq: 5, time: 1_350, data: {
    turn: 1,
    step: 1,
    message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '全部通过' }], isError: false }] }
  } });
  parser.consume({ type: 'assistant/message', seq: 6, time: 1_400, data: { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 8 } } });
  parser.consume({ type: 'step/end', seq: 7, time: 1_500, data: { turn: 1, step: 1 } });
  parser.consume({ type: 'turn/end', seq: 8, time: 1_600, data: { turn: 1, reason: { kind: 'error', error: { code: 'TRANSPORT', message: '连接断开' } } } });

  assert.deepEqual(traces.map((trace) => [trace.kind, trace.status]), [
    ['step', 'started'],
    ['command', 'started'],
    ['command', 'succeeded'],
    ['usage', 'info'],
    ['step', 'succeeded'],
    ['notice', 'failed']
  ]);
  assert.equal(traces[1].input.command, 'npm test');
  assert.match(traces[2].output.preview, /全部通过/);
  assert.equal(traces[2].metrics.durationMs, 250);
  assert.equal(traces[3].metrics.usage.inputTokens, 20);
  assert.equal(traces[4].metrics.durationMs, 500);
  assert.equal(traces[5].visibility, 'full');
  assert.match(traces[5].summary, /连接断开/);
});

test('思考分级：只有明确寒暄才降档，普通短问句保持默认档', () => {
  // 通过 buildClaudeArgs 的 --effort 是否出现间接验证 pickEffortLevel。
  const light = buildClaudeArgs('x', { access: 'read_only', phase: 'answer', userText: '你好呀！' }).join(' ');
  assert.match(light, /--effort low/);
  const question = buildClaudeArgs('x', { access: 'read_only', phase: 'answer', userText: '太阳为什么是热的？' }).join(' ');
  assert.doesNotMatch(question, /--effort/);
  const mixed = buildClaudeArgs('x', { access: 'read_only', phase: 'answer', userText: '谢谢，顺便帮我修一下这个 bug' }).join(' ');
  assert.doesNotMatch(mixed, /--effort/);
});
