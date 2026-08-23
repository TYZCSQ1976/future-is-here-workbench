const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createStateCenter } = require('../src/state-center');
const { createCollaborationLedger } = require('../src/collaboration-ledger');

test('成员定向消息只有目标成员能领取，并在处理后留下确认记录', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'future-collab-ledger-'));
  const center = createStateCenter(path.join(root, 'state.sqlite3'));
  try {
    const { run } = center.createRun({ sessionId: '1234567890', kind: 'collaboration', idempotencyKey: 'collab-1', input: {} });
    const ledger = createCollaborationLedger(center);
    ledger.recordTurn({
      runId: run.id,
      sessionId: run.sessionId,
      sender: { id: 'internal-a', provider: 'claude' },
      senderMemberId: 'member-1',
      round: 1,
      artifact: {
        position: '需要核实风险', claims: [], concerns: [], readyToSynthesize: false,
        messages: [{ toMemberId: 'member-2', type: 'question', content: '证据在哪里？', claimId: 'C1' }]
      }
    });
    assert.equal(ledger.claimInbox({ runId: run.id, recipientMemberId: 'member-1', round: 2 }).messages.length, 0);
    const inbox = ledger.claimInbox({ runId: run.id, recipientMemberId: 'member-2', round: 2 });
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.messages[0].fromMemberId, 'member-1');
    assert.equal(ledger.inboxSummary(run.id).pending, 1);
    ledger.acknowledgeInbox(inbox.deliveryIds, { responseRound: 2 });
    assert.deepEqual(ledger.inboxSummary(run.id), { total: 1, pending: 0, acknowledged: 1, failed: 0 });
  } finally {
    center.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
