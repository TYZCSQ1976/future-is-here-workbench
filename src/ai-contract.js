const { AppError } = require('./errors');

const SCHEMA_VERSION = 1;
const PROMPT_VERSION = 'role-immersive-collaboration-v2';
const MAX_ITEMS = 40;
const MAX_FIELD_CHARS = 12_000;
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

const SCHEMA_EXAMPLES = {
  team_plan: {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'team_plan',
    summary: '为什么这样组队',
    agents: [
      { provider: 'claude', name: '产品探索', role: '本次临时角色', focus: '重点关注范围' },
      { provider: 'codex', name: '证据验证', role: '本次临时角色', focus: '重点关注范围' }
    ],
    leadAgentIndex: 0,
    consensusPolicy: 'user_decides',
    dialogueRounds: 2
  },
  member_turn: {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'member_turn',
    position: '当前独立判断和理由',
    claims: [{ id: 'C1', statement: '一个可核验主张', basis: 'inference', evidence: '依据；没有证据时明确写未知' }],
    messages: [{ toMemberId: 'member-2', type: 'question', content: '发给另一位团队成员的定向问题或回应', claimId: 'C1' }],
    concerns: ['尚未解决的分歧或风险'],
    readyToSynthesize: false
  },
  proposal: {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'proposal',
    summary: '一句话概括方案',
    facts: [{ statement: '已确认事实', source: 'user', evidence: '来自用户目标的原句或可核验位置' }],
    assumptions: [{ statement: '尚未确认的假设', impact: 'medium', verification: '如何验证' }],
    steps: [{ id: 'S1', action: '具体动作', owner: 'system', deliverable: '明确产物', verification: '验收方法' }],
    risks: [{ severity: 'medium', description: '风险', mitigation: '缓解方法' }],
    acceptanceCriteria: ['可观察、可验证的完成标准'],
    openQuestions: []
  },
  review: {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'review',
    verdict: 'revise',
    summary: '审查结论',
    issues: [{ severity: 'high', category: '安全', description: '具体问题', evidence: '问题依据', requiredChange: '必须修改什么' }],
    unsupportedClaims: [{ claim: '未经证实的说法', reason: '为什么证据不足', requiredEvidence: '需要什么证据' }],
    checks: [{ criterion: '验收标准', result: 'fail', note: '失败原因' }]
  },
  implementation: {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'implementation',
    summary: '执行结果概括',
    deliverables: [{ stepId: 'S1', content: '完成的产物或代码', verification: '如何验证该产物' }],
    limitations: ['仍未完成或无法证明的限制'],
    userActions: ['需要用户最终决定或手动完成的动作']
  },
  verification: {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'verification',
    verdict: 'revise',
    summary: '验证结论',
    checks: [{ criterion: '验收标准', result: 'fail', evidence: '可复核证据' }],
    remainingRisks: [{ severity: 'high', description: '残余风险', mitigation: '下一步缓解方法' }],
    requiredFixes: ['通过前必须修复的事项']
  }
};

function contractError(message) {
  return new AppError(502, 'PROVIDER_INVALID_OUTPUT', `AI 返回结果不符合可靠性协议：${message}`);
}

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw contractError(`${field}必须是对象`);
  return value;
}

function requireString(value, field, max = MAX_FIELD_CHARS) {
  if (typeof value !== 'string' || !value.trim()) throw contractError(`${field}必须是非空文本`);
  const text = value.trim();
  if (text.length > max) throw contractError(`${field}超过长度限制`);
  return text;
}

function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return '';
  return requireString(value, field);
}

function requireEnum(value, field, allowed) {
  if (!allowed.includes(value)) throw contractError(`${field}必须是 ${allowed.join('/')}`);
  return value;
}

function requireArray(value, field, { min = 0, max = MAX_ITEMS } = {}) {
  if (!Array.isArray(value)) throw contractError(`${field}必须是数组`);
  if (value.length < min) throw contractError(`${field}至少需要 ${min} 项`);
  if (value.length > max) throw contractError(`${field}最多允许 ${max} 项`);
  return value;
}

function strings(value, field, options) {
  return requireArray(value, field, options).map((item, index) => requireString(item, `${field}[${index}]`));
}

function validateBase(value, expectedType) {
  const data = requireObject(value, '根对象');
  if (data.schemaVersion !== SCHEMA_VERSION) throw contractError(`schemaVersion 必须是 ${SCHEMA_VERSION}`);
  if (data.artifactType !== expectedType) throw contractError(`artifactType 必须是 ${expectedType}`);
  return data;
}

function validateProposal(value) {
  const data = validateBase(value, 'proposal');
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'proposal',
    summary: requireString(data.summary, 'summary'),
    facts: requireArray(data.facts, 'facts').map((item, index) => {
      const fact = requireObject(item, `facts[${index}]`);
      return {
        statement: requireString(fact.statement, `facts[${index}].statement`),
        source: requireEnum(fact.source, `facts[${index}].source`, ['user', 'repository', 'system', 'provider', 'inference']),
        evidence: requireString(fact.evidence, `facts[${index}].evidence`)
      };
    }),
    assumptions: requireArray(data.assumptions, 'assumptions').map((item, index) => {
      const assumption = requireObject(item, `assumptions[${index}]`);
      return {
        statement: requireString(assumption.statement, `assumptions[${index}].statement`),
        impact: requireEnum(assumption.impact, `assumptions[${index}].impact`, ['low', 'medium', 'high']),
        verification: requireString(assumption.verification, `assumptions[${index}].verification`)
      };
    }),
    steps: requireArray(data.steps, 'steps', { min: 1 }).map((item, index) => {
      const step = requireObject(item, `steps[${index}]`);
      return {
        id: requireString(step.id, `steps[${index}].id`, 40),
        action: requireString(step.action, `steps[${index}].action`),
        owner: requireString(step.owner, `steps[${index}].owner`, 40),
        deliverable: requireString(step.deliverable, `steps[${index}].deliverable`),
        verification: requireString(step.verification, `steps[${index}].verification`)
      };
    }),
    risks: requireArray(data.risks, 'risks').map((item, index) => {
      const risk = requireObject(item, `risks[${index}]`);
      return {
        severity: requireEnum(risk.severity, `risks[${index}].severity`, SEVERITIES),
        description: requireString(risk.description, `risks[${index}].description`),
        mitigation: requireString(risk.mitigation, `risks[${index}].mitigation`)
      };
    }),
    acceptanceCriteria: strings(data.acceptanceCriteria, 'acceptanceCriteria', { min: 1 }),
    openQuestions: strings(data.openQuestions, 'openQuestions')
  };
}

function validateTeamPlan(value) {
  const data = validateBase(value, 'team_plan');
  const agents = requireArray(data.agents, 'agents', { min: 2, max: 6 }).map((item, index) => {
    const agent = requireObject(item, `agents[${index}]`);
    return {
      provider: requireEnum(agent.provider, `agents[${index}].provider`, ['claude', 'codex', 'dsh']),
      name: requireString(agent.name, `agents[${index}].name`, 80),
      role: requireString(agent.role, `agents[${index}].role`, 200),
      focus: requireString(agent.focus, `agents[${index}].focus`, 1_000)
    };
  });
  if (!Number.isInteger(data.leadAgentIndex) || data.leadAgentIndex < 0 || data.leadAgentIndex >= agents.length) {
    throw contractError('leadAgentIndex 必须指向 agents 中的一名成员');
  }
  if (!Number.isInteger(data.dialogueRounds) || data.dialogueRounds < 1 || data.dialogueRounds > 5) {
    throw contractError('dialogueRounds 必须是 1 到 5');
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'team_plan',
    summary: requireString(data.summary, 'summary'),
    agents,
    leadAgentIndex: data.leadAgentIndex,
    consensusPolicy: requireEnum(data.consensusPolicy, 'consensusPolicy', ['unanimous', 'majority', 'user_decides']),
    dialogueRounds: data.dialogueRounds
  };
}

function validateMemberTurn(value) {
  const data = validateBase(value, 'member_turn');
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'member_turn',
    position: requireString(data.position, 'position'),
    claims: requireArray(data.claims, 'claims').map((item, index) => {
      const claim = requireObject(item, `claims[${index}]`);
      return {
        id: requireString(claim.id, `claims[${index}].id`, 80),
        statement: requireString(claim.statement, `claims[${index}].statement`),
        basis: requireEnum(claim.basis, `claims[${index}].basis`, ['user', 'repository', 'peer', 'inference', 'unknown']),
        evidence: requireString(claim.evidence, `claims[${index}].evidence`)
      };
    }),
    messages: requireArray(data.messages, 'messages').map((item, index) => {
      const message = requireObject(item, `messages[${index}]`);
      return {
        toMemberId: requireString(message.toMemberId, `messages[${index}].toMemberId`, 40),
        type: requireEnum(message.type, `messages[${index}].type`, ['question', 'answer', 'challenge', 'agreement']),
        content: requireString(message.content, `messages[${index}].content`),
        claimId: optionalString(message.claimId, `messages[${index}].claimId`)
      };
    }),
    concerns: strings(data.concerns, 'concerns'),
    readyToSynthesize: data.readyToSynthesize === true
  };
}

function validateReview(value) {
  const data = validateBase(value, 'review');
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'review',
    verdict: requireEnum(data.verdict, 'verdict', ['approve', 'revise', 'block']),
    summary: requireString(data.summary, 'summary'),
    issues: requireArray(data.issues, 'issues').map((item, index) => {
      const issue = requireObject(item, `issues[${index}]`);
      return {
        severity: requireEnum(issue.severity, `issues[${index}].severity`, SEVERITIES),
        category: requireString(issue.category, `issues[${index}].category`, 120),
        description: requireString(issue.description, `issues[${index}].description`),
        evidence: requireString(issue.evidence, `issues[${index}].evidence`),
        requiredChange: requireString(issue.requiredChange, `issues[${index}].requiredChange`)
      };
    }),
    unsupportedClaims: requireArray(data.unsupportedClaims, 'unsupportedClaims').map((item, index) => {
      const claim = requireObject(item, `unsupportedClaims[${index}]`);
      return {
        claim: requireString(claim.claim, `unsupportedClaims[${index}].claim`),
        reason: requireString(claim.reason, `unsupportedClaims[${index}].reason`),
        requiredEvidence: requireString(claim.requiredEvidence, `unsupportedClaims[${index}].requiredEvidence`)
      };
    }),
    checks: requireArray(data.checks, 'checks', { min: 1 }).map((item, index) => {
      const check = requireObject(item, `checks[${index}]`);
      return {
        criterion: requireString(check.criterion, `checks[${index}].criterion`),
        result: requireEnum(check.result, `checks[${index}].result`, ['pass', 'fail', 'unknown']),
        note: optionalString(check.note, `checks[${index}].note`)
      };
    })
  };
}

function validateImplementation(value) {
  const data = validateBase(value, 'implementation');
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'implementation',
    summary: requireString(data.summary, 'summary'),
    deliverables: requireArray(data.deliverables, 'deliverables', { min: 1 }).map((item, index) => {
      const deliverable = requireObject(item, `deliverables[${index}]`);
      return {
        stepId: requireString(deliverable.stepId, `deliverables[${index}].stepId`, 40),
        content: requireString(deliverable.content, `deliverables[${index}].content`),
        verification: requireString(deliverable.verification, `deliverables[${index}].verification`)
      };
    }),
    limitations: strings(data.limitations, 'limitations'),
    userActions: strings(data.userActions, 'userActions')
  };
}

function validateVerification(value) {
  const data = validateBase(value, 'verification');
  return {
    schemaVersion: SCHEMA_VERSION,
    artifactType: 'verification',
    verdict: requireEnum(data.verdict, 'verdict', ['pass', 'revise', 'block']),
    summary: requireString(data.summary, 'summary'),
    checks: requireArray(data.checks, 'checks', { min: 1 }).map((item, index) => {
      const check = requireObject(item, `checks[${index}]`);
      return {
        criterion: requireString(check.criterion, `checks[${index}].criterion`),
        result: requireEnum(check.result, `checks[${index}].result`, ['pass', 'fail', 'unknown']),
        evidence: requireString(check.evidence, `checks[${index}].evidence`)
      };
    }),
    remainingRisks: requireArray(data.remainingRisks, 'remainingRisks').map((item, index) => {
      const risk = requireObject(item, `remainingRisks[${index}]`);
      return {
        severity: requireEnum(risk.severity, `remainingRisks[${index}].severity`, SEVERITIES),
        description: requireString(risk.description, `remainingRisks[${index}].description`),
        mitigation: requireString(risk.mitigation, `remainingRisks[${index}].mitigation`)
      };
    }),
    requiredFixes: strings(data.requiredFixes, 'requiredFixes')
  };
}

const VALIDATORS = {
  team_plan: validateTeamPlan,
  member_turn: validateMemberTurn,
  proposal: validateProposal,
  review: validateReview,
  implementation: validateImplementation,
  verification: validateVerification
};

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw contractError('结果为空');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(candidate.slice(start, end + 1)); } catch (_) {}
    }
    throw contractError('不是合法 JSON');
  }
}

function parseArtifact(text, expectedType) {
  const validate = VALIDATORS[expectedType];
  if (!validate) throw new AppError(500, 'UNKNOWN_ARTIFACT_TYPE', '未知的 AI 产物类型');
  return validate(extractJson(text));
}

function schemaInstruction(type) {
  const example = SCHEMA_EXAMPLES[type];
  if (!example) throw new Error(`未知的协议类型：${type}`);
  return `\n\n你必须只输出一个合法 JSON 对象，不要输出 Markdown 围栏、解释或额外文字。字段名、枚举值和层级必须严格遵守下面的结构；内容使用中文：\n${JSON.stringify(example, null, 2)}`;
}

function repairPrompt(type, rawText, errorMessage) {
  return `上一份结果没有通过机器校验。错误：${errorMessage}\n请只修复格式和缺失字段，不要添加无法从原内容支持的新事实。\n原始结果：\n---\n${String(rawText || '').slice(0, 60_000)}\n---${schemaInstruction(type)}`;
}

function reviewDecision(review) {
  // issues 中每一项都带 requiredChange，因此任何未解决问题都不能被“口头 approve”绕过。
  const blockingIssues = review.issues;
  const incompleteChecks = review.checks.filter((check) => check.result !== 'pass');
  const approved = review.verdict === 'approve'
    && blockingIssues.length === 0
    && review.unsupportedClaims.length === 0
    && incompleteChecks.length === 0;
  return {
    approved,
    declaredVerdict: review.verdict,
    effectiveVerdict: approved ? 'approve' : review.verdict === 'block' ? 'block' : 'revise',
    blockingIssueCount: blockingIssues.length,
    unsupportedClaimCount: review.unsupportedClaims.length,
    incompleteCheckCount: incompleteChecks.length
  };
}

function verificationDecision(verification) {
  const blockingRisks = verification.remainingRisks.filter((risk) => ['high', 'critical'].includes(risk.severity));
  const incompleteChecks = verification.checks.filter((check) => check.result !== 'pass');
  const passed = verification.verdict === 'pass'
    && blockingRisks.length === 0
    && verification.requiredFixes.length === 0
    && incompleteChecks.length === 0;
  return {
    passed,
    declaredVerdict: verification.verdict,
    effectiveVerdict: passed ? 'pass' : verification.verdict === 'block' ? 'block' : 'revise',
    blockingRiskCount: blockingRisks.length,
    requiredFixCount: verification.requiredFixes.length,
    incompleteCheckCount: incompleteChecks.length
  };
}

function list(items, render, empty = '无') {
  return items.length ? items.map(render).join('\n') : empty;
}

function renderArtifact(artifact) {
  if (artifact.artifactType === 'member_turn') {
    return [
      `## 当前立场\n\n${artifact.position}`,
      `## 主张与依据\n\n${list(artifact.claims, (item) => `- **${item.id}** ${item.statement}\n  - 依据类型：${item.basis}\n  - 证据：${item.evidence}`)}`,
      `## 给其他团队成员的消息\n\n${list(artifact.messages, (item) => `- **${item.type} → ${item.toMemberId}**${item.claimId ? `（${item.claimId}）` : ''}：${item.content}`)}`,
      `## 尚存疑虑\n\n${list(artifact.concerns, (item) => `- ${item}`)}`,
      `## 是否可以开始汇总\n\n${artifact.readyToSynthesize ? '是' : '否，仍需继续讨论'}`
    ].join('\n\n');
  }
  if (artifact.artifactType === 'proposal') {
    return [
      `## 方案摘要\n\n${artifact.summary}`,
      `## 已确认事实\n\n${list(artifact.facts, (item) => `- ${item.statement}（来源：${item.source}；证据：${item.evidence}）`)}`,
      `## 假设与验证\n\n${list(artifact.assumptions, (item) => `- **${item.impact}**：${item.statement}；验证：${item.verification}`)}`,
      `## 执行步骤\n\n${list(artifact.steps, (item) => `${item.id}. ${item.action}\n   - 负责人：${item.owner}\n   - 产物：${item.deliverable}\n   - 验证：${item.verification}`)}`,
      `## 风险与缓解\n\n${list(artifact.risks, (item) => `- **${item.severity}**：${item.description}；缓解：${item.mitigation}`)}`,
      `## 验收标准\n\n${list(artifact.acceptanceCriteria, (item) => `- ${item}`)}`,
      `## 待确认问题\n\n${list(artifact.openQuestions, (item) => `- ${item}`)}`
    ].join('\n\n');
  }
  if (artifact.artifactType === 'review') {
    const decision = reviewDecision(artifact);
    return [
      `## 审查结论：${decision.effectiveVerdict.toUpperCase()}\n\n${artifact.summary}`,
      `## 问题清单\n\n${list(artifact.issues, (item) => `- **${item.severity} / ${item.category}**：${item.description}\n  - 依据：${item.evidence}\n  - 必须修改：${item.requiredChange}`)}`,
      `## 缺失证据\n\n${list(artifact.unsupportedClaims, (item) => `- ${item.claim}：${item.reason}；需要：${item.requiredEvidence}`)}`,
      `## 验收检查\n\n${list(artifact.checks, (item) => `- ${item.result === 'pass' ? '✅' : item.result === 'fail' ? '❌' : '❓'} ${item.criterion}${item.note ? `：${item.note}` : ''}`)}`
    ].join('\n\n');
  }
  if (artifact.artifactType === 'implementation') {
    return [
      `## 执行结果\n\n${artifact.summary}`,
      `## 交付物\n\n${list(artifact.deliverables, (item) => `### ${item.stepId}\n\n${item.content}\n\n验证：${item.verification}`)}`,
      `## 当前限制\n\n${list(artifact.limitations, (item) => `- ${item}`)}`,
      `## 需要用户完成\n\n${list(artifact.userActions, (item) => `- ${item}`)}`
    ].join('\n\n');
  }
  const decision = verificationDecision(artifact);
  return [
    `## 验证结论：${decision.effectiveVerdict.toUpperCase()}\n\n${artifact.summary}`,
    `## 验收检查\n\n${list(artifact.checks, (item) => `- ${item.result === 'pass' ? '✅' : item.result === 'fail' ? '❌' : '❓'} ${item.criterion}：${item.evidence}`)}`,
    `## 残余风险\n\n${list(artifact.remainingRisks, (item) => `- **${item.severity}**：${item.description}；缓解：${item.mitigation}`)}`,
    `## 必须修复\n\n${list(artifact.requiredFixes, (item) => `- ${item}`)}`
  ].join('\n\n');
}

module.exports = {
  SCHEMA_VERSION,
  PROMPT_VERSION,
  schemaInstruction,
  repairPrompt,
  parseArtifact,
  renderArtifact,
  reviewDecision,
  verificationDecision
};
