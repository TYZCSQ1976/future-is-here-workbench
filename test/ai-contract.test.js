const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseArtifact,
  reviewDecision,
  verificationDecision,
  renderArtifact,
  schemaInstruction
} = require('../src/ai-contract');

function proposal() {
  return {
    schemaVersion: 1,
    artifactType: 'proposal',
    summary: '可靠方案',
    facts: [{ statement: '用户要求多智能体协作', source: 'user', evidence: '用户目标' }],
    assumptions: [],
    steps: [{ id: 'S1', action: '实现结构化协议', owner: 'system', deliverable: '可校验产物', verification: '运行测试' }],
    risks: [],
    acceptanceCriteria: ['所有测试通过'],
    openQuestions: []
  };
}

test('结构化提案会被运行时校验并渲染为可读文本', () => {
  const parsed = parseArtifact(JSON.stringify(proposal()), 'proposal');
  assert.equal(parsed.steps[0].id, 'S1');
  assert.match(renderArtifact(parsed), /所有测试通过/);
  assert.throws(() => parseArtifact(JSON.stringify({ ...proposal(), steps: [] }), 'proposal'), /至少需要 1 项/);
});

test('AI 组队建议必须包含可编辑成员、主笔和会议规则', () => {
  const parsed = parseArtifact(JSON.stringify({
    schemaVersion: 1,
    artifactType: 'team_plan',
    summary: '让产品探索与安全验证互相补位',
    agents: [
      { provider: 'claude', name: '需求考古员', role: '澄清目标', focus: '用户意图与成功标准' },
      { provider: 'claude', name: '反例研究员', role: '挑战假设', focus: '失败场景与盲区' },
      { provider: 'codex', name: '证据核验员', role: '验证结论', focus: '代码证据与测试方法' }
    ],
    leadAgentIndex: 0,
    consensusPolicy: 'user_decides',
    dialogueRounds: 3
  }), 'team_plan');
  assert.equal(parsed.agents.length, 3);
  assert.equal(parsed.agents.filter((agent) => agent.provider === 'claude').length, 2);
  assert.throws(() => parseArtifact(JSON.stringify({ ...parsed, leadAgentIndex: 5 }), 'team_plan'), /必须指向/);
});

test('组队建议允许 dsh 作为成员 Provider', () => {
  const parsed = parseArtifact(JSON.stringify({
    schemaVersion: 1,
    artifactType: 'team_plan',
    summary: '三引擎互证团队',
    agents: [
      { provider: 'claude', name: '探索员', role: '目标探索', focus: '需求' },
      { provider: 'codex', name: '测试员', role: '测试证据', focus: '验收' },
      { provider: 'dsh', name: '架构员', role: '架构边界', focus: '可恢复性' }
    ],
    leadAgentIndex: 2,
    consensusPolicy: 'majority',
    dialogueRounds: 2
  }), 'team_plan');
  assert.equal(parsed.agents[2].provider, 'dsh');
  const badTeam = { ...parsed, agents: parsed.agents.map((agent, index) => index === 0 ? { ...agent, provider: 'gemini' } : agent) };
  assert.throws(() => parseArtifact(JSON.stringify(badTeam), 'team_plan'), /claude\/codex\/dsh/);
});

test('团队发言只接受中性成员编号，不再接受底层实例路由字段', () => {
  const turn = {
    schemaVersion: 1,
    artifactType: 'member_turn',
    position: '先核对目标再决定方案',
    claims: [{ id: 'C1', statement: '目标仍需澄清', basis: 'user', evidence: '用户没有给出完成期限' }],
    messages: [{ toMemberId: 'member-2', type: 'question', content: '你能否补充风险判断？', claimId: 'C1' }],
    concerns: ['完成期限未知'],
    readyToSynthesize: false
  };
  assert.equal(parseArtifact(JSON.stringify(turn), 'member_turn').messages[0].toMemberId, 'member-2');
  assert.throws(() => parseArtifact(JSON.stringify({
    ...turn,
    messages: [{ toAgentId: 'codex-1', type: 'question', content: '旧路由字段' }]
  }), 'member_turn'), /toMemberId/);
});

test('成员发言示例默认不制造新问题，并允许直接进入汇总', () => {
  const instruction = schemaInstruction('member_turn');
  assert.match(instruction, /"messages": \[\]/);
  assert.match(instruction, /"concerns": \[\]/);
  assert.match(instruction, /"readyToSynthesize": true/);
});

test('模型自称批准不等于真正通过确定性审查', () => {
  const review = {
    schemaVersion: 1,
    artifactType: 'review',
    verdict: 'approve',
    summary: '口头批准',
    issues: [],
    unsupportedClaims: [{ claim: '已运行测试', reason: '没有执行证据', requiredEvidence: '测试输出' }],
    checks: [{ criterion: '测试通过', result: 'pass', note: '' }]
  };
  const parsed = parseArtifact(JSON.stringify(review), 'review');
  assert.equal(reviewDecision(parsed).approved, false);
  assert.equal(reviewDecision(parsed).unsupportedClaimCount, 1);
});

test('即使只是低级问题，只要存在必须修改项也不能批准', () => {
  const review = parseArtifact(JSON.stringify({
    schemaVersion: 1,
    artifactType: 'review',
    verdict: 'approve',
    summary: '仍有一个小问题',
    issues: [{ severity: 'low', category: '可维护性', description: '命名不清楚', evidence: '步骤 S1', requiredChange: '改成明确命名' }],
    unsupportedClaims: [],
    checks: [{ criterion: '命名清楚', result: 'pass', note: '模型自称通过' }]
  }), 'review');
  assert.equal(reviewDecision(review).approved, false);
  assert.equal(reviewDecision(review).blockingIssueCount, 1);
});

test('最终验证存在未知检查时不能标记完成', () => {
  const verification = parseArtifact(JSON.stringify({
    schemaVersion: 1,
    artifactType: 'verification',
    verdict: 'pass',
    summary: '尚无真实运行证据',
    checks: [{ criterion: '真实测试', result: 'unknown', evidence: '只生成了文本' }],
    remainingRisks: [],
    requiredFixes: []
  }), 'verification');
  assert.equal(verificationDecision(verification).passed, false);
});
