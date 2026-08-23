const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSessionCreate,
  validateChatRequest,
  validateCollabRequest,
  validateTeamSuggestRequest,
  validateExecuteRequest,
  validateWorkspaceCommandRequest,
  validateImportDiscussionRequest
} = require('../src/validation');

test('请求校验拒绝 null、错误任务 ID 和超长消息', () => {
  assert.throws(() => validateSessionCreate(null), /请求体必须是对象/);
  assert.throws(() => validateChatRequest({ sessionId: 'bad', message: '你好', agent: 'claude' }), /无效的任务 ID/);
  assert.throws(() => validateChatRequest({ sessionId: '1234567890', message: '', agent: 'claude' }), /消息不能为空/);
  assert.throws(() => validateChatRequest({ sessionId: '1234567890', message: 'x'.repeat(20_001), agent: 'claude' }), /消息太长了/);
});

test('多 AI 对话支持任意成员组合，旧版单选和全选请求仍兼容', () => {
  assert.deepEqual(validateChatRequest({ sessionId: '1234567890', message: '讨论方案', agents: ['claude', 'dsh'] }), {
    sessionId: '1234567890', message: '讨论方案', attachments: [], folder: null,
    agents: ['claude', 'dsh'], agent: 'all', coordination: 'cross_check', requestId: null
  });
  assert.equal(validateChatRequest({
    sessionId: '1234567890', message: '快速给出两个视角', agents: ['claude', 'codex'], coordination: 'independent'
  }).coordination, 'independent');
  assert.throws(() => validateChatRequest({
    sessionId: '1234567890', message: '无效模式', agents: ['claude', 'codex'], coordination: 'round_robin_forever'
  }), /无效的双 AI 方式/);
  assert.throws(() => validateChatRequest({
    sessionId: '1234567890', message: '单人不能互证', agents: ['claude'], coordination: 'cross_check'
  }), /只适用于双 AI/);
  assert.throws(() => validateChatRequest({ sessionId: '1234567890', message: '空名单', agents: [] }), /至少选择一个/);
  assert.throws(() => validateChatRequest({ sessionId: '1234567890', message: '重复名单', agents: ['claude', 'claude'] }), /不能重复/);
  assert.deepEqual(validateChatRequest({ sessionId: '1234567890', message: '旧版全选', agent: 'all' }).agents, ['claude', 'codex', 'dsh']);
  assert.deepEqual(validateChatRequest({ sessionId: '1234567890', message: '旧版单选', agent: 'codex' }).agents, ['codex']);
});

test('dsh 可以作为对话对象、组队顾问和团队成员', () => {
  assert.equal(validateChatRequest({ sessionId: '1234567890', message: '单独问 dsh', agent: 'dsh' }).agent, 'dsh');
  assert.equal(validateTeamSuggestRequest({ goal: '组队', mode: 'division', plannerProvider: 'dsh', desiredCount: 3 }).plannerProvider, 'dsh');
  assert.throws(() => validateTeamSuggestRequest({ goal: '组队', mode: 'division', plannerProvider: 'all', desiredCount: 3 }), /一次只能选择一个 AI/);
  const request = validateCollabRequest({
    sessionId: '1234567890', goal: '三 AI 协作', mode: 'review',
    team: {
      agents: [
        { id: 'claude-1', provider: 'claude', name: '产品', role: '探索', focus: '目标' },
        { id: 'codex-1', provider: 'codex', name: '测试', role: '验证', focus: '证据' },
        { id: 'dsh-1', provider: 'dsh', name: '架构', role: '架构师', focus: '边界' }
      ],
      leadAgentId: 'dsh-1', consensusPolicy: 'unanimous', dialogueRounds: 2
    }
  });
  assert.equal(request.team.agents.length, 3);
  assert.equal(request.team.leadAgentId, 'dsh-1');
});

test('图片和文件夹附件有数量、类型和大小边界', () => {
  const image = 'data:image/png;base64,aGVsbG8=';
  const result = validateChatRequest({ sessionId: '1234567890', message: '', agent: 'claude', attachments: [{ name: '截图.png', data: image }] });
  assert.equal(result.attachments[0].mimeType, 'image/png');
  assert.throws(() => validateChatRequest({ sessionId: '1234567890', message: 'x', agent: 'claude', attachments: [{ data: 'data:text/plain;base64,aGVsbG8=' }] }), /只支持/);
  assert.throws(() => validateChatRequest({ sessionId: '1234567890', message: 'x', agent: 'claude', folder: { name: '越界', files: [{ path: '../secret.txt', data: 'data:text/plain;base64,aGVsbG8=' }] } }), /无效路径/);
  const reference = validateChatRequest({ sessionId: '1234567890', message: '', agent: 'claude', folder: { uploadId: '00000000-0000-4000-8000-000000000000', name: '大资料' } });
  assert.equal(reference.folder.uploadId, '00000000-0000-4000-8000-000000000000');
  assert.throws(() => validateChatRequest({ sessionId: '1234567890', message: 'x', agent: 'claude', folder: { uploadId: '../../bad' } }), /编号无效/);
});

test('默认禁止绕过用户确认闸门', () => {
  assert.throws(() => validateCollabRequest({
    sessionId: '1234567890',
    goal: '完成可靠任务',
    mode: 'cocreation',
    gateMode: 'auto'
  }), /必须由你确认方案/);
});

test('执行确认只接受合法任务 ID，方案字段可选', () => {
  const input = {
    sessionId: '1234567890',
    expectedJobId: 'job-1',
    expectedPlanHash: 'a'.repeat(64),
    expectedContextDigest: 'b'.repeat(64)
  };
  assert.deepEqual(validateExecuteRequest(input), {
    sessionId: '1234567890',
    plan: null,
    expectedJobId: 'job-1',
    expectedPlanHash: 'a'.repeat(64),
    expectedContextDigest: 'b'.repeat(64),
    expectedDeterministicVerificationPlanHash: null,
    acknowledgeDisagreement: false
  });
  assert.equal(validateExecuteRequest({ ...input, expectedDeterministicVerificationPlanHash: 'c'.repeat(64) }).expectedDeterministicVerificationPlanHash, 'c'.repeat(64));
  assert.throws(() => validateExecuteRequest({ ...input, plan: 'x'.repeat(120_001) }), /方案太长了/);
});

test('组队建议请求必须指定一个顾问和合法人数', () => {
  assert.deepEqual(validateTeamSuggestRequest({
    goal: '根据任务临时组队',
    mode: 'division',
    plannerProvider: 'codex',
    desiredCount: 4
  }), {
    goal: '根据任务临时组队',
    mode: 'division',
    plannerProvider: 'codex',
    desiredCount: 4
  });
  assert.throws(() => validateTeamSuggestRequest({
    goal: '根据任务临时组队', mode: 'division', plannerProvider: 'all', desiredCount: 4
  }), /一次只能选择一个 AI/);
  assert.throws(() => validateTeamSuggestRequest({
    goal: '根据任务临时组队', mode: 'division', plannerProvider: 'claude', desiredCount: 7
  }), /人数必须在/);
});

test('方案讨论任务和工作区命令有独立请求合同', () => {
  assert.equal(validateSessionCreate({ name: '方案讨论', type: 'discussion' }).type, 'discussion');
  assert.deepEqual(validateWorkspaceCommandRequest({ sessionId: '1234567890', command: 'cd /tmp/project' }), { sessionId: '1234567890', command: 'cd /tmp/project' });
  assert.deepEqual(validateImportDiscussionRequest({ sourceSessionId: '1234567890' }), { sourceSessionId: '1234567890' });
  assert.throws(() => validateWorkspaceCommandRequest({ sessionId: '1234567890', command: '' }), /不能为空/);
});
