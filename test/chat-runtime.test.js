const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSessionStore } = require('../src/session-store');
const { createStateCenter } = require('../src/state-center');
const { createRunEventBus } = require('../src/run-event-bus');
const { createChatRuntime } = require('../src/chat-runtime');

function fixture(providers, getProviderHealth) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'future-chat-runtime-'));
  const store = createSessionStore(path.join(root, 'sessions'));
  const stateCenter = createStateCenter(path.join(root, 'state.sqlite3'));
  const eventBus = createRunEventBus(stateCenter);
  const runtime = createChatRuntime({ stateCenter, eventBus, store, providers, getProviderHealth });
  const session = store.createSession({ name: '新任务', type: 'chat', collabMode: null });
  return { root, store, stateCenter, eventBus, runtime, session };
}

test('Provider 轨迹与回答一起进入持久事件流，敏感信息不会写入数据库', async () => {
  const fx = fixture({
    async invoke(provider, _request, options) {
      options.onTrace({
        invocationId: 'fake-invocation',
        actionId: 'fake-command',
        kind: 'command',
        status: 'succeeded',
        title: '执行检查',
        summary: 'npm test',
        input: { command: 'TOKEN=private-value npm test' },
        output: { preview: '全部通过' },
        metrics: { durationMs: 25 },
        source: 'test-provider',
        visibility: 'full'
      });
      return { text: '检查完成', provider, model: 'fake', durationMs: 1, receivedAt: new Date().toISOString() };
    }
  });
  try {
    const run = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '请检查',
      agent: 'claude',
      coordination: 'independent',
      requestId: 'trace-persistence'
    });
    await fx.runtime.waitForIdle(run.id);
    const traceEvent = fx.stateCenter.listEvents(run.id).find((event) => event.type === 'chat_agent_trace');
    assert.ok(traceEvent);
    assert.equal(traceEvent.payload.schemaVersion, 1);
    assert.equal(traceEvent.payload.kind, 'command');
    assert.equal(traceEvent.payload.status, 'succeeded');
    assert.equal(traceEvent.payload.memberName, '协作成员 1');
    assert.match(traceEvent.payload.input.command, /已隐藏/);
    assert.doesNotMatch(JSON.stringify(traceEvent.payload), /private-value/);
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('多 AI 只调度健康成员，并明确记录被跳过的 Provider', async () => {
  const calls = [];
  const fx = fixture({
    async invoke(provider) {
      calls.push(provider);
      return { text: `${provider} 正常`, provider, model: 'fake', durationMs: 1, receivedAt: new Date().toISOString() };
    }
  }, async () => [
    { provider: 'claude', ready: true },
    { provider: 'codex', ready: true },
    { provider: 'dsh', ready: false, error: { code: 'PROVIDER_START_FAILED', message: 'dsh 未安装' } }
  ]);
  try {
    const run = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '只问可用成员',
      agent: 'all',
      coordination: 'independent',
      requestId: 'healthy-providers-only'
    });
    const completed = await fx.runtime.waitForIdle(run.id);
    assert.equal(completed.state, 'succeeded');
    assert.deepEqual(calls.sort(), ['claude', 'codex']);
    const started = fx.stateCenter.listEvents(run.id).find((event) => event.type === 'chat_start');
    assert.deepEqual(started.payload.skippedProviders, [{ provider: 'dsh', reason: 'dsh 未安装' }]);
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('用户手动选择两个成员时只调度这两个成员', async () => {
  const calls = [];
  const fx = fixture({
    async invoke(provider) {
      calls.push(provider);
      return { text: `${provider} 正常`, provider, model: 'fake', durationMs: 1, receivedAt: new Date().toISOString() };
    }
  });
  try {
    const run = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '只问 Claude 和 DeepSeek',
      agents: ['claude', 'dsh'],
      agent: 'all',
      coordination: 'independent',
      requestId: 'two-selected-providers'
    });
    const completed = await fx.runtime.waitForIdle(run.id);
    assert.equal(completed.state, 'succeeded');
    assert.deepEqual(calls.sort(), ['claude', 'dsh']);
    assert.deepEqual(completed.input.agents, ['claude', 'dsh']);
    assert.deepEqual(fx.store.getSession(fx.session.id).job.agents, ['claude', 'dsh']);
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('后台对话把多成员回答、互证、投递确认和事件完整持久化', async () => {
  const calls = [];
  const fx = fixture({
    async invoke(provider, request) {
      calls.push({ provider, prompt: request.prompt });
      return {
        text: request.prompt.includes('互相确认轮') ? `${provider} 的复核` : `${provider} 的独立回答`,
        provider, model: 'fake', durationMs: 1, receivedAt: new Date().toISOString(), access: 'read_only'
      };
    }
  });
  try {
    const run = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '请给出可靠方案',
      agent: 'all',
      coordination: 'cross_check',
      requestId: 'browser-request-1'
    });
    const completed = await fx.runtime.waitForIdle(run.id);
    assert.equal(completed.state, 'succeeded');
    // 'all' 现在同时问 Claude、Codex、dsh：3 次独立回答 + 3 次互证。
    assert.equal(calls.length, 6);
    assert.deepEqual([...new Set(calls.map((item) => item.provider))].sort(), ['claude', 'codex', 'dsh']);
    assert.equal(fx.stateCenter.listDeliveries(run.id).every((item) => item.state === 'acked'), true);
    assert.equal(fx.stateCenter.listMessages(run.id).length, 6);
    assert.equal(fx.store.getSession(fx.session.id).messages.length, 7);
    assert.equal(fx.stateCenter.listEvents(run.id).at(-1).type, 'chat_complete');

    const duplicate = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '这条内容不能重复写入',
      agent: 'all',
      coordination: 'cross_check',
      requestId: 'browser-request-1'
    });
    assert.equal(duplicate.id, run.id);
    assert.equal(fx.store.getSession(fx.session.id).messages.length, 7);
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('Provider 短暂失败会有限重试，一方永久失败时保留其他成员结果', async () => {
  const attempts = { claude: 0, codex: 0, dsh: 0 };
  const fx = fixture({
    async invoke(provider) {
      attempts[provider] += 1;
      if (provider === 'claude') {
        const error = new Error('暂时失败');
        error.code = 'PROVIDER_TIMEOUT';
        error.userMessage = 'Claude 响应超时';
        throw error;
      }
      return { text: `${provider} 可用结果`, provider, model: 'fake', durationMs: 1, receivedAt: new Date().toISOString() };
    }
  });
  try {
    const run = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '保留部分结果',
      agent: 'all',
      coordination: 'cross_check',
      requestId: 'browser-request-2'
    });
    const completed = await fx.runtime.waitForIdle(run.id);
    assert.equal(completed.state, 'partial');
    assert.equal(attempts.claude, 1);
    // codex 与 dsh 都成功，进入互证轮：各自再回答一次。
    assert.equal(attempts.codex, 2);
    assert.equal(attempts.dsh, 2);
    assert.equal(fx.store.getSession(fx.session.id).messages.some((item) => item.text === 'codex 可用结果'), true);
    assert.equal(fx.store.getSession(fx.session.id).messages.some((item) => item.text === 'dsh 可用结果'), true);
    assert.equal(fx.stateCenter.listEvents(run.id).some((item) => item.type === 'chat_agent_retry'), false);
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('服务重启后会从持久投递恢复对话，不依赖原浏览器连接', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'future-chat-restart-'));
  const store = createSessionStore(path.join(root, 'sessions'));
  const session = store.createSession({ name: '恢复任务', type: 'chat', collabMode: null });
  const databasePath = path.join(root, 'state.sqlite3');
  let center = createStateCenter(databasePath);
  const created = center.createRun({
    sessionId: session.id,
    kind: 'chat',
    idempotencyKey: 'restart-request',
    input: { message: '重启后继续', coordination: 'independent', context: '用户: 重启后继续' },
    agents: [{ id: 'member-1', provider: 'codex', name: '协作成员 1' }]
  }).run;
  center.enqueueDelivery({
    runId: created.id,
    recipientId: 'member-1',
    phase: 'answer',
    dedupeKey: 'answer:member-1',
    payload: { provider: 'codex', memberName: '协作成员 1', prompt: '请恢复回答' }
  });
  await store.updateSession(session.id, (current) => {
    current.messages.push({ id: `user:${created.id}`, role: 'user', text: '重启后继续' });
    current.job = { id: created.id, kind: 'chat', state: 'queued', agent: 'codex', coordination: 'independent' };
    return current;
  });
  center.close();

  center = createStateCenter(databasePath);
  const bus = createRunEventBus(center);
  const runtime = createChatRuntime({
    stateCenter: center,
    eventBus: bus,
    store,
    providers: {
      async invoke(_provider, _request, options) {
        assert.equal(options.signal instanceof AbortSignal, true);
        assert.equal(options.signal.aborted, false);
        return { text: '这是恢复后的回答', provider: 'codex', model: 'fake', durationMs: 1, receivedAt: new Date().toISOString() };
      }
    }
  });
  try {
    assert.equal(runtime.resumePending(), 1);
    const completed = await runtime.waitForIdle(created.id);
    assert.equal(completed.state, 'succeeded');
    assert.equal(store.getSession(session.id).messages.some((item) => item.text === '这是恢复后的回答'), true);
  } finally {
    center.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('所有成员都失败时任务进入 failed 终态并发出 chat_complete(failed)', async () => {
  const fx = fixture({
    async invoke(provider) {
      const error = new Error(`${provider} 不可用`);
      error.code = 'PROVIDER_FAILED';
      error.userMessage = `${provider} 调用失败（退出码 1）`;
      throw error;
    }
  });
  try {
    const run = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '全部失败场景',
      agent: 'all',
      coordination: 'independent',
      requestId: 'all-fail'
    });
    const completed = await fx.runtime.waitForIdle(run.id);
    assert.equal(completed.state, 'failed');
    assert.equal(fx.stateCenter.listEvents(run.id).at(-1).type, 'chat_complete');
    const complete = fx.stateCenter.listEvents(run.id).find((event) => event.type === 'chat_complete');
    assert.equal(complete.payload.state, 'failed');
    assert.equal(fx.store.getSession(fx.session.id).job.state, 'failed');
    // 没有可用回答被持久化。
    assert.equal(fx.store.getSession(fx.session.id).messages.filter((item) => item.role === 'ai').length, 0);
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('所选成员全部不可用时提交被拒绝并说明每个原因', async () => {
  const fx = fixture({
    async invoke() { throw new Error('不应调用任何成员'); }
  }, async () => [
    { provider: 'claude', ready: false, error: { code: 'PROVIDER_START_FAILED', message: 'claude 未安装' } },
    { provider: 'codex', ready: false, error: { code: 'PROVIDER_FAILED', message: 'codex 退出码 1' } },
    { provider: 'dsh', ready: false, error: { code: 'PROVIDER_START_FAILED', message: 'dsh 未安装' } }
  ]);
  try {
    await assert.rejects(
      () => fx.runtime.submit({
        sessionId: fx.session.id,
        message: '全不可用',
        agent: 'all',
        coordination: 'independent',
        requestId: 'none-available'
      }),
      /所选 AI 当前都不可用：.*claude.*codex.*dsh/
    );
    assert.equal(fx.stateCenter.listRuns({}).length, 0);
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('互证轮跳过时提示文案按实际成功数动态生成', async () => {
  const fx = fixture({
    async invoke(provider) {
      if (provider === 'claude' || provider === 'dsh') {
        const error = new Error(`${provider} 失败`);
        error.code = 'PROVIDER_FAILED';
        error.userMessage = `${provider} 失败`;
        throw error;
      }
      return { text: 'codex 可用结果', provider, model: 'fake', durationMs: 1, receivedAt: new Date().toISOString() };
    }
  });
  try {
    const run = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '只剩一个成员',
      agent: 'all',
      coordination: 'cross_check',
      requestId: 'only-one-ok'
    });
    const completed = await fx.runtime.waitForIdle(run.id);
    assert.equal(completed.state, 'partial');
    const skipped = fx.stateCenter.listEvents(run.id).find((event) => event.type === 'chat_phase_skipped');
    assert.ok(skipped, '应发出 chat_phase_skipped');
    assert.match(skipped.payload.message, /只有 1 位成员成功返回/);
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('用户可以终止运行，任务进入 cancelled 终态且事件可重放', async () => {
  const fx = fixture({
    async invoke(_provider, _request, options) {
      await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('已取消');
          error.code = 'PROVIDER_CANCELLED';
          reject(error);
        }, { once: true });
      });
      return { text: '不应返回', provider: 'codex', model: 'fake', durationMs: 1, receivedAt: new Date().toISOString() };
    }
  });
  try {
    const run = await fx.runtime.submit({
      sessionId: fx.session.id,
      message: '等待被终止',
      agent: 'codex',
      coordination: 'independent',
      requestId: 'cancel-me'
    });
    // 等待 worker 真正领取投递并进入等待后取消。
    await new Promise((resolve) => setTimeout(resolve, 30));
    fx.runtime.cancel(run.id);
    const completed = await fx.runtime.waitForIdle(run.id);
    assert.equal(completed.state, 'cancelled');
    assert.equal(fx.stateCenter.listEvents(run.id).some((event) => event.type === 'run_cancelled'), true);
    assert.equal(fx.store.getSession(fx.session.id).job.state, 'cancelled');
  } finally {
    fx.stateCenter.close();
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
