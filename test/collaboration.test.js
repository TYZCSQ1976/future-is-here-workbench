const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../src/config');

const { extractResponseConstraints, buildMemberMemories, runDiscussion, runExecution, suggestTeam } = require('../src/collaboration');
const { createStateCenter } = require('../src/state-center');
const { createCollaborationLedger } = require('../src/collaboration-ledger');

function createMemoryStore() {
  const session = { messages: [], workflow: { phase: 'idle', round: 0, checkpoints: [] } };
  return {
    getSession() { return session; },
    async appendMessage(_id, message) { session.messages.push(message); },
    async recordWorkflowCheckpoint(_id, checkpoint) { session.workflow = { ...session.workflow, ...checkpoint }; session.workflow.checkpoints.push(checkpoint); }
  };
}

const proposal = {
  schemaVersion: 1,
  artifactType: 'proposal',
  summary: '实现可靠闭环',
  facts: [{ statement: '需要多人团队协作', source: 'user', evidence: '用户目标' }],
  assumptions: [],
  steps: [{ id: 'S1', action: '生成结构化产物', owner: 'member-1', deliverable: '方案', verification: '独立审查' }],
  risks: [],
  acceptanceCriteria: ['审查和验证均通过'],
  openQuestions: []
};

const review = {
  schemaVersion: 1,
  artifactType: 'review',
  verdict: 'approve',
  summary: '方案满足要求',
  issues: [],
  unsupportedClaims: [],
  checks: [{ criterion: '审查和验证均通过', result: 'pass', note: '已覆盖' }]
};

const implementation = {
  schemaVersion: 1,
  artifactType: 'implementation',
  summary: '已生成对应产物',
  deliverables: [{ stepId: 'S1', content: '结构化实现内容', verification: '交给 member-2 独立验证' }],
  limitations: [],
  userActions: []
};

const verification = {
  schemaVersion: 1,
  artifactType: 'verification',
  verdict: 'pass',
  summary: '所有验收项通过',
  checks: [{ criterion: '审查和验证均通过', result: 'pass', evidence: '结构化检查通过' }],
  remainingRisks: [],
  requiredFixes: []
};

function turn(position, toMemberId, type, ready) {
  return {
    schemaVersion: 1,
    artifactType: 'member_turn',
    position,
    claims: [{ id: 'C1', statement: position, basis: 'inference', evidence: '测试中的结构化依据' }],
    messages: [{ toMemberId, type, content: `${type}：请核对 C1`, claimId: 'C1' }],
    concerns: ready ? [] : ['等待另一位成员回应'],
    readyToSynthesize: ready
  };
}

test('完整协作链路必须经过提案、独立审查、执行和最终验证', async () => {
  const store = createMemoryStore();
  const events = [];
  const participantPrompts = [];
  const legacyNamedTeam = {
    agents: [
      { id: 'claude-1', provider: 'claude', name: 'Claude 1', role: '多角度探索者', focus: '理解目标与说明假设' },
      { id: 'codex-1', provider: 'codex', name: 'Codex 1', role: '证据挑战者', focus: '检查证据与边界' }
    ],
    leadAgentId: 'claude-1',
    consensusPolicy: 'user_decides',
    dialogueRounds: 2
  };
  const queues = {
    claude: [
      JSON.stringify(turn('成员一的独立立场', 'member-2', 'question', false)),
      JSON.stringify(turn('成员一回应后的立场', 'member-2', 'answer', true)),
      JSON.stringify(proposal),
      JSON.stringify(implementation)
    ],
    codex: [
      JSON.stringify(turn('成员二的独立立场', 'member-1', 'challenge', false)),
      JSON.stringify(turn('成员二回应后的立场', 'member-1', 'agreement', true)),
      JSON.stringify(review),
      JSON.stringify(verification)
    ]
  };
  const providers = {
    async claude(prompt, options) { participantPrompts.push(prompt); invocations.push({ provider: 'claude', phase: options?.phase, access: options?.access }); return queues.claude.shift(); },
    async codex(prompt, options) { participantPrompts.push(prompt); invocations.push({ provider: 'codex', phase: options?.phase, access: options?.access }); return queues.codex.shift(); }
  };
  const invocations = [];
  const discussion = await runDiscussion({
    sessionId: '1234567890', goal: '构建可靠工作台', modeKey: 'cocreation',
    team: legacyNamedTeam, sendEvent: (event) => events.push(event), store, providers
  });
  assert.equal(discussion.reliability.machineConsensusReached, true);
  assert.equal(discussion.planArtifact.artifactType, 'proposal');
  assert.equal(discussion.team.agents.length, 2);
  assert.equal(events.filter((event) => event.type === 'message' && event.artifact?.artifactType === 'member_turn').length, 4);

  const execution = await runExecution({
    sessionId: '1234567890', plan: discussion.plan, planArtifact: discussion.planArtifact,
    modeKey: 'cocreation', team: legacyNamedTeam, sendEvent: (event) => events.push(event), store, providers
  });
  assert.equal(execution.ok, true);
  assert.equal(execution.verification.passed, true);
  assert.equal(events.some((event) => event.type === 'verification' && event.passed), true);
  assert.equal(store.getSession().messages.every((message) => message.artifact && message.promptVersion && message.instanceId), true);
  assert.equal(participantPrompts.length, 8);
  for (const prompt of participantPrompts) {
    assert.doesNotMatch(prompt, /claude|codex|provider|分身|智能体/i);
    assert.doesNotMatch(prompt, /(?:claude|codex)-\d+/i);
    assert.match(prompt, /团队|成员|用户批准的方案/);
  }
  // 执行阶段必须区分阶段：主笔执行（execute）、独立验证（verify）、讨论（collaboration）。
  const executeCalls = invocations.filter((item) => item.phase === 'execute');
  const verifyCalls = invocations.filter((item) => item.phase === 'verify');
  const collaborationCalls = invocations.filter((item) => item.phase === 'collaboration');
  assert.ok(executeCalls.length >= 1, '主笔执行调用应使用 execute 阶段');
  assert.ok(verifyCalls.length >= 1, '独立验证调用应使用 verify 阶段');
  assert.ok(collaborationCalls.length >= 4, '讨论轮次应保持 collaboration 阶段');
});

test('成员路由元数据无效时不应让整场协作失败', async () => {
  const store = createMemoryStore();
  const invalidTurn = {
    schemaVersion: 1,
    artifactType: 'member_turn',
    position: '仍然可以继续分析项目',
    claims: [{ id: 'C1', statement: '项目需要继续核验', basis: 'inference', evidence: '测试证据' }],
    // 模拟模型误把消息发给自己，或写出不存在的成员编号。
    messages: [
      { toMemberId: 'member-1', type: 'question', content: '错误的自发消息', claimId: 'C1' },
      { toMemberId: 'member-ghost', type: 'question', content: '错误的目标消息', claimId: 'C1' }
    ],
    concerns: [],
    readyToSynthesize: false
  };
  const validTurn = turn('另一位成员的判断', 'member-1', 'challenge', false);
  const providers = {
    async claude(prompt, options) {
      if (prompt.includes('候选方案')) return JSON.stringify(proposal);
      return JSON.stringify(invalidTurn);
    },
    async codex(prompt) {
      if (prompt.includes('候选方案')) return JSON.stringify(review);
      return JSON.stringify(validTurn);
    }
  };
  const result = await runDiscussion({
    sessionId: '1234567890', goal: '测试无效路由的恢复', modeKey: 'cocreation',
    team: { agents: [
      { id: 'claude-1', provider: 'claude', name: '成员一', role: '探索', focus: '目标' },
      { id: 'codex-1', provider: 'codex', name: '成员二', role: '验证', focus: '证据' }
    ], leadAgentId: 'claude-1', consensusPolicy: 'user_decides', dialogueRounds: 1 },
    sendEvent() {}, store, providers
  });
  assert.equal(result.planArtifact.artifactType, 'proposal');
  assert.match(store.getSession().messages[0].text, /当前立场/);
});

test('格式修复事件记录具体校验原因，但不保存失败原文', async () => {
  const store = createMemoryStore();
  const events = [];
  const team = {
    agents: [
      { id: 'claude-1', provider: 'claude', name: '探索员', role: '探索', focus: '目标' },
      { id: 'codex-1', provider: 'codex', name: '核验员', role: '核验', focus: '证据' }
    ],
    leadAgentId: 'claude-1', consensusPolicy: 'user_decides', dialogueRounds: 1
  };
  const queues = {
    claude: [
      JSON.stringify({ ...turn('缺少消息数组', 'member-2', 'question', true), messages: null }),
      JSON.stringify({ ...turn('修复后的发言', 'member-2', 'answer', true), messages: [] }),
      JSON.stringify(proposal)
    ],
    codex: [
      JSON.stringify({ ...turn('核验发言', 'member-1', 'agreement', true), messages: [] }),
      JSON.stringify(review)
    ]
  };
  const providers = {
    async claude() { return queues.claude.shift(); },
    async codex() { return queues.codex.shift(); }
  };
  await runDiscussion({
    sessionId: '1234567890', goal: '验证格式修复原因', modeKey: 'cocreation',
    team, sendEvent: (event) => events.push(event), store, providers
  });
  const warning = events.find((event) => event.type === 'warning' && event.code === 'AI_CONTRACT_INVALID');
  assert.ok(warning);
  assert.match(warning.reason, /messages必须是数组/);
  assert.doesNotMatch(JSON.stringify(warning), /缺少消息数组/);
});

test('有安全只读能力的讨论成员应直接取证，且只在阻塞汇总时发问', async () => {
  const store = createMemoryStore();
  const prompts = [];
  const team = {
    agents: [
      { id: 'claude-1', provider: 'claude', name: '探索员', role: '探索', focus: '目标' },
      { id: 'codex-1', provider: 'codex', name: '核验员', role: '核验', focus: '证据' }
    ],
    leadAgentId: 'claude-1', consensusPolicy: 'user_decides', dialogueRounds: 1
  };
  const providers = {
    async claude(prompt) {
      prompts.push(prompt);
      return prompt.includes('多轮对话记录')
        ? JSON.stringify(proposal)
        : JSON.stringify({ ...turn('已取证', 'member-2', 'answer', true), messages: [] });
    },
    async codex(prompt) {
      prompts.push(prompt);
      return prompt.includes('候选方案')
        ? JSON.stringify(review)
        : JSON.stringify({ ...turn('已核验', 'member-1', 'agreement', true), messages: [] });
    }
  };
  await runDiscussion({
    sessionId: '1234567890', goal: '检查当前项目', modeKey: 'cocreation', team,
    sendEvent() {}, store, providers, workspacePath: '/tmp/authorized-workspace'
  });
  const turnPrompts = prompts.filter((prompt) => prompt.includes('当前第 1 轮'));
  assert.equal(turnPrompts.length, 2);
  for (const prompt of turnPrompts) {
    assert.match(prompt, /只读检查权限/);
    assert.match(prompt, /只有存在阻止汇总的关键问题/);
    assert.doesNotMatch(prompt, /主动提出要向其他成员确认的问题/);
    assert.doesNotMatch(prompt, /不执行命令、读取或修改本机文件/);
  }
});

test('真实收件箱中只有回答与同意时仍执行用户指定轮数，并结清非阻塞投递', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'future-collab-integration-'));
  const center = createStateCenter(path.join(root, 'state.sqlite3'));
  try {
    const store = createMemoryStore();
    const events = [];
    const team = {
      agents: [
        { id: 'claude-1', provider: 'claude', name: '探索员', role: '探索', focus: '目标' },
        { id: 'codex-1', provider: 'codex', name: '核验员', role: '核验', focus: '证据' }
      ],
      leadAgentId: 'claude-1', consensusPolicy: 'user_decides', dialogueRounds: 3
    };
    const { run } = center.createRun({ sessionId: '1234567890', kind: 'collaboration', idempotencyKey: 'nonblocking-rounds', input: {} });
    const ledger = createCollaborationLedger(center);
    const queues = {
      claude: [
        JSON.stringify(turn('第一轮提问', 'member-2', 'question', false)),
        JSON.stringify(turn('第二轮回答', 'member-2', 'answer', true)),
        JSON.stringify({ ...turn('第三轮收束', 'member-2', 'agreement', true), messages: [] }),
        JSON.stringify(proposal)
      ],
      codex: [
        JSON.stringify(turn('第一轮质疑', 'member-1', 'challenge', false)),
        JSON.stringify(turn('第二轮同意', 'member-1', 'agreement', true)),
        JSON.stringify({ ...turn('第三轮收束', 'member-1', 'agreement', true), messages: [] }),
        JSON.stringify(review)
      ]
    };
    const providers = {
      async claude() { return queues.claude.shift(); },
      async codex() { return queues.codex.shift(); }
    };
    const result = await runDiscussion({
      sessionId: run.sessionId, goal: '两轮内完成讨论', modeKey: 'cocreation', team,
      sendEvent: (event) => events.push(event), store, providers, ledger, runId: run.id
    });
    assert.equal(events.filter((event) => event.type === 'round').length, 3);
    assert.equal(events.find((event) => event.type === 'orchestration_decision')?.reason, 'configured_rounds_remaining');
    assert.equal(events.filter((event) => event.type === 'orchestration_decision').at(-1)?.reason, 'round_limit');
    assert.equal(result.reliability.machineConsensusReached, true);
    assert.equal(ledger.inboxSummary(run.id).pending, 0);
    assert.equal(ledger.inboxSummary(run.id).acknowledged, 4);
  } finally {
    center.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('新一轮协作会带上同一任务此前的对话记录', async () => {
  const prompts = [];
  const store = createMemoryStore();
  const team = {
    agents: [
      { id: 'claude-1', provider: 'claude', name: '成员一', role: '探索', focus: '目标' },
      { id: 'codex-1', provider: 'codex', name: '成员二', role: '验证', focus: '证据' }
    ],
    leadAgentId: 'claude-1', consensusPolicy: 'user_decides', dialogueRounds: 1
  };
  const queues = {
    claude: [JSON.stringify(turn('延续旧讨论', 'member-2', 'question', true)), JSON.stringify(proposal)],
    codex: [JSON.stringify(turn('核对旧讨论', 'member-1', 'answer', true)), JSON.stringify(review)]
  };
  const providers = {
    async claude(prompt) { prompts.push(prompt); return queues.claude.shift(); },
    async codex(prompt) { prompts.push(prompt); return queues.codex.shift(); }
  };
  await runDiscussion({
    sessionId: '1234567890', goal: '继续完善', modeKey: 'cocreation',
    team, sendEvent() {}, store, providers,
    conversationContext: '用户此前说：请保留工作目录和聊天记录'
  });
  assert.equal(prompts.some((prompt) => prompt.includes('请保留工作目录和聊天记录')), true);
});

test('直接汇总和字数要求由代码强制执行，并加载成员自己的跨轮记忆', async () => {
  assert.deepEqual(extractResponseConstraints('直接进行汇总，每个人都用200字以内讲明白'), {
    directSummary: true,
    maxChars: 200
  });
  const store = createMemoryStore();
  const events = [];
  const prompts = [];
  const team = {
    agents: [
      { id: 'claude-1', provider: 'claude', name: 'cc1', role: '探索', focus: '目标' },
      { id: 'codex-1', provider: 'codex', name: 'ch1', role: '验证', focus: '证据' }
    ],
    leadAgentId: 'claude-1', consensusPolicy: 'user_decides', dialogueRounds: 3
  };
  const memberMemories = buildMemberMemories([
    { role: 'ai', instanceId: 'claude-1', instanceName: '旧名字', text: 'cc1 上次确认的独有结论' },
    { role: 'ai', instanceId: 'codex-1', instanceName: 'ch1', text: 'ch1 上次的独有证据' }
  ], team);
  const longTurn = (position, target) => JSON.stringify({
    ...turn(position.repeat(80), target, 'answer', true), messages: []
  });
  const longProposal = JSON.stringify({ ...proposal, summary: '汇总结论'.repeat(80) });
  const longReview = JSON.stringify({ ...review, summary: '复核结论'.repeat(80) });
  const providers = {
    async claude(prompt) {
      prompts.push(prompt);
      return prompt.includes('多轮对话记录') ? longProposal : longTurn('甲方结论', 'member-2');
    },
    async codex(prompt) {
      prompts.push(prompt);
      return prompt.includes('候选方案') ? longReview : longTurn('乙方结论', 'member-1');
    }
  };
  await runDiscussion({
    sessionId: '1234567890', goal: '直接进行汇总，每个人都用200字以内讲明白', modeKey: 'cocreation',
    team, sendEvent: (event) => events.push(event), store, providers, memberMemories
  });
  assert.equal(events.filter((event) => event.type === 'round').length, 1);
  assert.equal(store.getSession().messages.every((message) => message.text.length <= 200), true);
  assert.equal(prompts.some((prompt) => prompt.includes('cc1 上次确认的独有结论')), true);
  assert.equal(prompts.some((prompt) => prompt.includes('最新用户要求优先')), true);
  assert.equal(events.some((event) => event.type === 'memory' && event.providerCacheGuaranteed === false), true);
});

test('组队顾问可以建议同一 Provider 的多个隔离分身，最终仍返回可编辑团队', async () => {
  const teamPlan = {
    schemaVersion: 1,
    artifactType: 'team_plan',
    summary: '这个任务需要两个独立 Claude 视角和一个 Codex 验证视角',
    agents: [
      { provider: 'claude', name: '产品分身', role: '产品负责人', focus: '目标与体验' },
      { provider: 'claude', name: '架构分身', role: '架构师', focus: '边界与恢复' },
      { provider: 'codex', name: '验证分身', role: '验证工程师', focus: '证据与测试' }
    ],
    leadAgentIndex: 1,
    consensusPolicy: 'user_decides',
    dialogueRounds: 3
  };
  const providers = { async claude() { return JSON.stringify(teamPlan); } };
  const result = await suggestTeam({
    goal: '建设可恢复的 AI 工作台',
    modeKey: 'division',
    plannerProvider: 'claude',
    desiredCount: 3,
    providers
  });
  assert.equal(result.team.agents.length, 3);
  assert.equal(result.team.leadAgentId, 'claude-2');
  assert.equal(result.team.agents[0].id, 'claude-1');
  assert.match(result.summary, /两个独立 Claude/);
});

test('组队顾问没有按用户指定人数返回时会修复一次后安全停止', async () => {
  let calls = 0;
  const wrongSizePlan = {
    schemaVersion: 1,
    artifactType: 'team_plan',
    summary: '人数错误的建议',
    agents: [
      { provider: 'claude', name: '成员一', role: '探索', focus: '目标' },
      { provider: 'codex', name: '成员二', role: '验证', focus: '证据' }
    ],
    leadAgentIndex: 0,
    consensusPolicy: 'user_decides',
    dialogueRounds: 2
  };
  const providers = { async codex() { calls += 1; return JSON.stringify(wrongSizePlan); } };
  await assert.rejects(() => suggestTeam({
    goal: '必须组建四人团队',
    modeKey: 'division',
    plannerProvider: 'codex',
    desiredCount: 4,
    providers
  }), /连续返回无法校验/);
  assert.equal(calls, 2);
});

test('绑定工作区后主笔获得写权限并产生真实文件，复核者保持只读', async () => {
  const workspacePath = fs.mkdtempSync(path.join(config.PROJECT_ROOT, '.execution-test-'));
  const store = createMemoryStore();
  const accesses = [];
  let claudeCalls = 0;
  const providers = {
    async claude(_prompt, options) {
      claudeCalls += 1;
      accesses.push({ provider: 'claude', access: options.access, workspacePath: options.workspacePath, phase: options.phase });
      if (claudeCalls === 1) {
        fs.writeFileSync(path.join(options.workspacePath, 'implemented.txt'), '真实执行产物');
        return '已经执行，但报告格式不正确';
      }
      return JSON.stringify(implementation);
    },
    async codex(_prompt, options) {
      accesses.push({ provider: 'codex', access: options.access, workspacePath: options.workspacePath, phase: options.phase });
      return JSON.stringify(verification);
    }
  };
  try {
    const result = await runExecution({
      sessionId: '1234567890', plan: '实施方案', planArtifact: proposal, modeKey: 'cocreation',
      workspacePath, sendEvent() {}, store, providers
    });
    assert.equal(result.ok, true);
    assert.equal(result.changes.changedCount, 1);
    assert.equal(fs.readFileSync(path.join(workspacePath, 'implemented.txt'), 'utf8'), '真实执行产物');
    assert.deepEqual(accesses.map((item) => item.access), ['workspace_write', 'read_only', 'read_only']);
    // 阶段必须跟随调用：主笔执行（含格式修复轮）为 execute，复核为 verify。
    assert.deepEqual(accesses.map((item) => item.phase), ['execute', 'execute', 'verify']);
    assert.equal(accesses.every((item) => item.workspacePath === workspacePath), true);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('系统检查失败时即使 AI 声称通过也不能进入交付', async () => {
  const workspacePath = fs.mkdtempSync(path.join(config.PROJECT_ROOT, '.deterministic-failure-test-'));
  const store = createMemoryStore();
  const events = [];
  const team = {
    agents: [
      { id: 'claude-1', provider: 'claude', name: '执行者', role: '实施', focus: '文件修改' },
      { id: 'codex-1', provider: 'codex', name: '复核者', role: '验证', focus: '测试证据' }
    ],
    leadAgentId: 'claude-1', consensusPolicy: 'unanimous', dialogueRounds: 1
  };
  const providers = {
    async claude(_prompt, options) {
      fs.writeFileSync(path.join(options.workspacePath, 'implemented.txt'), '候选修改');
      return JSON.stringify(implementation);
    },
    async codex() { return JSON.stringify(verification); }
  };
  try {
    const result = await runExecution({
      sessionId: '1234567890', plan: '实施方案', planArtifact: proposal, modeKey: 'cocreation',
      team, workspacePath, sendEvent: (event) => events.push(event), store, providers,
      deterministicVerificationPlan: { hash: 'approved-plan' },
      async verificationRunner() {
        return {
          schemaVersion: 1,
          planHash: 'approved-plan',
          required: true,
          status: 'failed',
          passed: false,
          commands: [{ id: 'npm:test', displayCommand: 'npm test', status: 'failed', exitCode: 1, durationMs: 10, output: '1 个测试失败' }]
        };
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.verification.passed, false);
    assert.equal(result.verification.deterministic.passed, false);
    assert.equal(result.verification.passedCount, 1, 'AI 复核可以通过，但不能覆盖真实命令的失败退出码');
    assert.equal(events.some((event) => event.type === 'deterministic_verification' && event.passed === false), true);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});
