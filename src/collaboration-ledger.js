const crypto = require('node:crypto');

function createCollaborationLedger(stateCenter) {
  const isBlockingMessage = (delivery) => ['question', 'challenge'].includes(delivery?.payload?.type);

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

  function settleInformational(runId, result = {}) {
    let settled = 0;
    for (const delivery of stateCenter.listDeliveries(runId, 'directed_message')) {
      if (!['pending', 'interrupted'].includes(delivery.state) || isBlockingMessage(delivery)) continue;
      const claimed = stateCenter.claimDelivery(delivery.id, `dialogue-settle:${process.pid}:${crypto.randomUUID()}`);
      if (!claimed) continue;
      stateCenter.acknowledgeDelivery(delivery.id, { ...result, disposition: 'no_response_required' });
      settled += 1;
    }
    return settled;
  }

  function inboxSummary(runId) {
    const deliveries = stateCenter.listDeliveries(runId, 'directed_message');
    const pendingDeliveries = deliveries.filter((item) => ['pending', 'interrupted', 'leased'].includes(item.state));
    const failedDeliveries = deliveries.filter((item) => item.state === 'dead_letter');
    const blockingPending = pendingDeliveries.filter(isBlockingMessage).length;
    return {
      total: deliveries.length,
      pending: pendingDeliveries.length,
      blockingPending,
      informationalPending: pendingDeliveries.length - blockingPending,
      acknowledged: deliveries.filter((item) => item.state === 'acked').length,
      failed: failedDeliveries.length,
      blockingFailed: failedDeliveries.filter(isBlockingMessage).length
    };
  }

  return { recordTurn, claimInbox, acknowledgeInbox, settleInformational, inboxSummary };
}

module.exports = { createCollaborationLedger };
