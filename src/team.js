const config = require('./config');
const { AppError } = require('./errors');

const CONSENSUS_POLICIES = ['unanimous', 'majority', 'user_decides'];

function cleanText(value, field, max = 1_000) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'INVALID_TEAM', `${field}不能为空`);
  }
  const text = value.trim();
  if (text.length > max) throw new AppError(400, 'INVALID_TEAM', `${field}太长了`);
  return text;
}

function defaultTeam() {
  return {
    version: 1,
    agents: [
      { id: 'claude-1', provider: 'claude', name: '目标探索员', role: '多角度探索者', focus: '理解目标、提出方案并主动说明假设' },
      { id: 'codex-1', provider: 'codex', name: '证据核验员', role: '证据挑战者', focus: '寻找反例、缺失证据、边界情况和验证方法' }
    ],
    leadAgentId: 'claude-1',
    consensusPolicy: 'user_decides',
    dialogueRounds: 2
  };
}

function validateTeam(input) {
  const source = input === undefined || input === null ? defaultTeam() : input;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new AppError(400, 'INVALID_TEAM', '团队配置必须是对象');
  }
  if (!Array.isArray(source.agents) || source.agents.length < 2 || source.agents.length > config.MAX_TEAM_SIZE) {
    throw new AppError(400, 'INVALID_TEAM_SIZE', `每个团队需要 2 到 ${config.MAX_TEAM_SIZE} 个智能体`);
  }
  const ids = new Set();
  const agents = source.agents.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError(400, 'INVALID_TEAM', `第 ${index + 1} 个智能体配置无效`);
    }
    const id = cleanText(item.id, `智能体 ${index + 1} ID`, 40);
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new AppError(400, 'INVALID_TEAM', `智能体 ${id} 的 ID 格式无效`);
    if (ids.has(id)) throw new AppError(400, 'DUPLICATE_AGENT_ID', `智能体 ID ${id} 重复`);
    ids.add(id);
    if (!config.PROVIDER_KEYS.includes(item.provider)) {
      throw new AppError(400, 'UNSUPPORTED_PROVIDER', `暂不支持 Provider：${item.provider}`);
    }
    return {
      id,
      provider: item.provider,
      name: cleanText(item.name, `智能体 ${id} 名称`, 80),
      role: cleanText(item.role, `智能体 ${id} 角色`, 200),
      focus: cleanText(item.focus, `智能体 ${id} 关注点`, 1_000)
    };
  });
  const leadAgentId = cleanText(source.leadAgentId, '主笔智能体', 40);
  if (!ids.has(leadAgentId)) throw new AppError(400, 'INVALID_TEAM_LEAD', '主笔智能体必须属于当前团队');
  const consensusPolicy = source.consensusPolicy || 'user_decides';
  if (!CONSENSUS_POLICIES.includes(consensusPolicy)) {
    throw new AppError(400, 'INVALID_CONSENSUS_POLICY', '无效的共识规则');
  }
  const dialogueRounds = Number(source.dialogueRounds ?? 2);
  if (!Number.isInteger(dialogueRounds) || dialogueRounds < 1 || dialogueRounds > config.MAX_DIALOGUE_ROUNDS) {
    throw new AppError(400, 'INVALID_DIALOGUE_ROUNDS', `讨论轮数必须在 1 到 ${config.MAX_DIALOGUE_ROUNDS} 之间`);
  }
  return { version: 1, agents, leadAgentId, consensusPolicy, dialogueRounds };
}

function getAgent(team, agentId) {
  return team.agents.find((agent) => agent.id === agentId) || null;
}

module.exports = { CONSENSUS_POLICIES, defaultTeam, validateTeam, getAgent };
