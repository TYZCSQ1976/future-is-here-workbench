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
    action: 'synthesize', preserveDisagreement: false, reason: 'team_ready'
  });
  assert.deepEqual(decideDialogueAction({ round: 4, maxRounds: 4, turns: readyTurns, inbox: { pending: 2 } }), {
    action: 'synthesize', preserveDisagreement: true, reason: 'round_limit'
  });
});
