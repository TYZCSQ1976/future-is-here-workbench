const crypto = require('node:crypto');

function createCollaborationLedger(stateCenter) {
  function recordTurn({ runId, sessionId, sender, senderMemberId, round, artifact }) {
    const message = stateCenter.recordMessage({
      runId,
      sessionId,
      senderId: sender.id,
      phase: `dialogue:${round}`,
      kind: 'member_turn',
      text: JSON.stringify(artifact),
      metadata: { memberId: senderMemberId, provider: sender.provider, round }
    });
    artifact.messages.forEach((outgoing, index) => {
      stateCenter.enqueueDelivery({
        runId,
        recipientId: outgoing.toMemberId,
        phase: 'directed_message',
        dedupeKey: `round:${round}:${senderMemberId}:${outgoing.toMemberId}:${index}`,
        payload: {
          round,
          fromMemberId: senderMemberId,
          toMemberId: outgoing.toMemberId,
          type: outgoing.type,
          content: outgoing.content,
          claimId: outgoing.claimId || null,
          sourceMessageId: message.id
        },
        maxAttempts: 3
      });
    });
    return message;
  }

  function claimInbox({ runId, recipientMemberId, round }) {
    const workerId = `dialogue:${process.pid}:${crypto.randomUUID()}`;
    const claimed = [];
    for (const delivery of stateCenter.listDeliveries(runId, 'directed_message')) {
      if (delivery.recipientId !== recipientMemberId || !['pending', 'interrupted'].includes(delivery.state)) continue;
      if (Number(delivery.payload.round || 0) >= round) continue;
      const item = stateCenter.claimDelivery(delivery.id, workerId);
      if (item) claimed.push(item);
    }
    return {
      deliveryIds: claimed.map((item) => item.id),
      messages: claimed.map((item) => item.payload)
    };
  }

  function acknowledgeInbox(deliveryIds, result = {}) {
    for (const id of deliveryIds) stateCenter.acknowledgeDelivery(id, result);
  }

  function inboxSummary(runId) {
    const deliveries = stateCenter.listDeliveries(runId, 'directed_message');
    return {
      total: deliveries.length,
      pending: deliveries.filter((item) => ['pending', 'interrupted', 'leased'].includes(item.state)).length,
      acknowledged: deliveries.filter((item) => item.state === 'acked').length,
      failed: deliveries.filter((item) => item.state === 'dead_letter').length
    };
  }

  return { recordTurn, claimInbox, acknowledgeInbox, inboxSummary };
}

module.exports = { createCollaborationLedger };
