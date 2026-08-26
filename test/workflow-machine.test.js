const test = require('node:test');
const assert = require('node:assert/strict');

const { assertJobTransition, decideDialogueAction } = require('../src/workflow-machine');

test('任务状态机禁止跳过人工批准和最终交付闸门', () => {
  assert.doesNotThrow(() => assertJobTransition('waiting_approval', 'executing'));
  assert.doesNotThrow(() => assertJobTransition('executing', 'waiting_delivery'));
  assert.doesNotThrow(() => assertJobTransition('waiting_delivery', 'succeeded'));
  assert.throws(() => assertJobTransition('waiting_approval', 'succeeded'), /不能从/);
  assert.throws(() => assertJobTransition('executing', 'succeeded'), /不能从/);
});

test('动态讨论优先处理定向收件箱，达到上限时保留分歧后汇总', () => {
  const readyTurns = [
    { readyToSynthesize: true, concerns: [] },
    { readyToSynthesize: true, concerns: [] }
  ];
  assert.equal(decideDialogueAction({ round: 2, maxRounds: 4, turns: readyTurns, inbox: { pending: 1 } }).action, 'continue');
  assert.deepEqual(decideDialogueAction({ round: 2, maxRounds: 4, turns: readyTurns, inbox: { pending: 0 } }), {
    action: 'continue', preserveDisagreement: false, reason: 'configured_rounds_remaining'
  });
  assert.deepEqual(decideDialogueAction({ round: 4, maxRounds: 4, turns: readyTurns, inbox: { pending: 2 } }), {
    action: 'synthesize', preserveDisagreement: true, reason: 'round_limit'
  });
});

test('回答与同意不制造分歧，但仍按用户指定轮数继续', () => {
  const readyTurns = [
    { readyToSynthesize: true, concerns: [] },
    { readyToSynthesize: true, concerns: [] }
  ];
  assert.deepEqual(decideDialogueAction({
    round: 2,
    maxRounds: 4,
    turns: readyTurns,
    inbox: { pending: 4, blockingPending: 0 }
  }), {
    action: 'continue', preserveDisagreement: false, reason: 'configured_rounds_remaining'
  });
  assert.deepEqual(decideDialogueAction({
    round: 2,
    maxRounds: 4,
    turns: readyTurns,
    inbox: { pending: 4, blockingPending: 1 }
  }), {
    action: 'continue', preserveDisagreement: true, reason: 'directed_messages_pending'
  });
});

test('用户明确选择的讨论轮数必须完整执行，成员提前准备好也不能擅自缩短', () => {
  const readyTurns = [
    { readyToSynthesize: true, concerns: [] },
    { readyToSynthesize: true, concerns: [] }
  ];
  assert.deepEqual(decideDialogueAction({
    round: 3,
    maxRounds: 5,
    turns: readyTurns,
    inbox: { pending: 0, blockingPending: 0 }
  }), {
    action: 'continue', preserveDisagreement: false, reason: 'configured_rounds_remaining'
  });
});
