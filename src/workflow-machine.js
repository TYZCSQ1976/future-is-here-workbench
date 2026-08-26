const { AppError } = require('./errors');

const JOB_TRANSITIONS = Object.freeze({
  queued: ['running', 'interrupted', 'failed', 'cancelled'],
  running: ['waiting_approval', 'plan_ready', 'partial', 'succeeded', 'failed', 'interrupted', 'cancelled'],
  waiting_approval: ['executing', 'failed', 'cancelled'],
  approved: ['executing', 'failed'],
  executing: ['waiting_delivery', 'needs_revision', 'failed', 'interrupted', 'cancelled'],
  waiting_delivery: ['succeeded', 'cancelled'],
  needs_revision: ['waiting_approval', 'cancelled'],
  interrupted: ['queued', 'running', 'failed', 'cancelled'],
  plan_ready: [],
  partial: [],
  succeeded: [],
  failed: [],
  cancelled: []
});

function assertJobTransition(from, to) {
  if (!from || !to || from === to) return true;
  const allowed = JOB_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new AppError(409, 'INVALID_JOB_TRANSITION', `任务不能从 ${from} 直接变为 ${to}`);
  }
  return true;
}

function decideDialogueAction({ round, maxRounds, turns, inbox }) {
  // 兼容旧调用方：没有细分统计时，仍把全部待处理消息视为阻塞。
  // 新调用方只让 question/challenge 推动下一轮；answer/agreement 是信息，不要求再次回应。
  const pending = Number(inbox?.blockingPending ?? inbox?.pending ?? 0);
  const failed = Number(inbox?.blockingFailed ?? inbox?.failed ?? 0);
  const allReady = Array.isArray(turns) && turns.length > 0
    && turns.every((turn) => turn.readyToSynthesize === true && Array.isArray(turn.concerns) && turn.concerns.length === 0);
  if (round >= maxRounds) {
    return { action: 'synthesize', preserveDisagreement: pending > 0 || failed > 0 || !allReady, reason: 'round_limit' };
  }
  if (pending > 0) return { action: 'continue', preserveDisagreement: true, reason: 'directed_messages_pending' };
  // “讨论轮数”是用户的明确选择，不是模型可以自行缩短的上限。
  // 即使成员提前认为可以汇总，也继续到用户指定轮数；这样成本和流程都可预期。
  if (allReady) return { action: 'continue', preserveDisagreement: false, reason: 'configured_rounds_remaining' };
  return { action: 'continue', preserveDisagreement: true, reason: 'concerns_remaining' };
}

module.exports = { JOB_TRANSITIONS, assertJobTransition, decideDialogueAction };
