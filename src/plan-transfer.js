const crypto = require('crypto');
const { AppError } = require('./errors');

async function importDiscussionPlan(store, sourceSessionId, approvalContext = {}) {
  const source = store.getSession(sourceSessionId);
  const plan = source.discussionPlan;
  if (!plan?.plan || !plan.planArtifact || !plan.team) {
    throw new AppError(409, 'DISCUSSION_PLAN_NOT_READY', '这个讨论还没有形成可导入的方案');
  }
  return store.updateSession(source.id, (session) => {
    const now = new Date().toISOString();
    session.type = 'collab';
    session.lastMode = 'collab';
    session.collabMode = plan.mode;
    session.team = plan.team;
    if (!session.messages.some((message) => message.instanceId === 'imported-plan' && message.planHash === plan.planHash)) {
      session.messages.push({
        role: 'ai', text: plan.plan, artifact: plan.planArtifact, agent: 'system',
        instanceId: 'imported-plan', instanceName: '讨论室方案', collabRole: '已导入方案',
        interactionMode: 'collab', planHash: plan.planHash, timestamp: now
      });
    }
    session.workflow = {
      ...session.workflow,
      objective: plan.goal,
      mode: plan.mode,
      phase: 'awaiting_user_decision',
      reliability: plan.reliability,
      acceptedPlan: plan.planArtifact,
      promptVersion: plan.promptVersion,
      updatedAt: now
    };
    session.job = {
      id: crypto.randomUUID(),
      kind: 'imported_plan',
      state: 'waiting_approval',
      mode: plan.mode,
      goal: plan.goal,
      team: plan.team,
      plan: plan.plan,
      planArtifact: plan.planArtifact,
      reviewArtifacts: plan.reviewArtifacts,
      reliability: plan.reliability,
      planHash: plan.planHash,
      contextDigest: approvalContext.contextDigest || null,
      contextNodeIds: approvalContext.contextNodeIds || [],
      deterministicVerificationPlan: approvalContext.deterministicVerificationPlan || null,
      promptVersion: plan.promptVersion,
      createdAt: now,
      updatedAt: now
    };
    return session;
  });
}

module.exports = { importDiscussionPlan };
