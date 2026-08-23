const test = require('node:test');
const assert = require('node:assert/strict');

const { validateTeam } = require('../src/team');
const { validateTurnRouting, aggregateReviews, createParticipantDirectory } = require('../src/collaboration');

test('同一 Provider 可以创建多个相互独立的智能体实例', () => {
  const team = validateTeam({
    agents: [
      { id: 'claude-a', provider: 'claude', name: 'Claude A', role: '产品', focus: '用户价值' },
      { id: 'claude-b', provider: 'claude', name: 'Claude B', role: '工程', focus: '实现边界' },
      { id: 'codex-a', provider: 'codex', name: 'Codex A', role: '验证', focus: '证据和测试' }
    ],
    leadAgentId: 'claude-b',
    consensusPolicy: 'user_decides',
    dialogueRounds: 3
  });
  assert.equal(team.agents.filter((agent) => agent.provider === 'claude').length, 2);
  assert.equal(team.leadAgentId, 'claude-b');
});

test('参会名册只暴露中性成员身份，不暴露底层 Provider', () => {
  const team = validateTeam();
  const directory = createParticipantDirectory(team);
  assert.deepEqual(directory.entries.map((entry) => entry.memberId), ['member-1', 'member-2']);
  assert.equal(JSON.stringify(directory.entries).match(/claude|codex|provider|分身/i), null);
  assert.equal(directory.internalToMember['claude-1'], 'member-1');
});

test('定向消息只能发送给当前团队中的其他实例', () => {
  const team = validateTeam();
  assert.doesNotThrow(() => validateTurnRouting({ messages: [{ toMemberId: 'member-2' }] }, team, 'claude-1'));
  assert.throws(() => validateTurnRouting({ messages: [{ toMemberId: 'member-1' }] }, team, 'claude-1'), /不能把定向消息发给自己/);
  assert.throws(() => validateTurnRouting({ messages: [{ toMemberId: 'ghost' }] }, team, 'claude-1'), /不属于当前团队/);
});

test('保留分歧模式不会伪装成机器共识', () => {
  const team = validateTeam();
  const result = aggregateReviews(team, [{
    instance: team.agents[1],
    result: { artifact: {
      verdict: 'revise',
      issues: [{ severity: 'medium' }],
      unsupportedClaims: [],
      checks: [{ result: 'fail' }]
    } }
  }]);
  assert.equal(result.machineConsensusReached, false);
  assert.equal(result.requiresUserDecision, true);
  assert.equal(result.issueCount, 1);
});
