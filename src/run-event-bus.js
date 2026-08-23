function createRunEventBus(stateCenter) {
  const listeners = new Map();
  // 即时事件监听器：不经过数据库持久化，只推给当前在线的 SSE 连接。
  const liveListeners = new Map();

  function broadcast(event) {
    for (const listener of listeners.get(event.runId) || []) {
      try { listener(event); } catch (_) {}
    }
    return event;
  }

  function publish(runId, type, payload = {}) {
    return broadcast(stateCenter.appendEvent(runId, type, payload));
  }

  function subscribe(runId, afterSequence, listener, { replay = true } = {}) {
    let lastSequence = Math.max(0, Number(afterSequence) || 0);
    const deliver = (event) => {
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      listener(event);
    };
    if (replay) {
      for (const event of stateCenter.listEvents(runId, lastSequence)) deliver(event);
    }
    if (!listeners.has(runId)) listeners.set(runId, new Set());
    listeners.get(runId).add(deliver);
    return () => {
      const runListeners = listeners.get(runId);
      if (!runListeners) return;
      runListeners.delete(deliver);
      if (runListeners.size === 0) listeners.delete(runId);
    };
  }

  // 即时事件：不持久化、不走序列号去重，只广播给当前在线监听器。
  // 用于 token 流等高频、临时性的实时数据。
  function emit(runId, type, payload = {}) {
    const event = { runId, type, payload, createdAt: new Date().toISOString() };
    for (const listener of liveListeners.get(runId) || []) {
      try { listener(event); } catch (_) {}
    }
  }

  function onLive(runId, listener) {
    if (!liveListeners.has(runId)) liveListeners.set(runId, new Set());
    liveListeners.get(runId).add(listener);
    return () => {
      const set = liveListeners.get(runId);
      if (!set) return;
      set.delete(listener);
      if (set.size === 0) liveListeners.delete(runId);
    };
  }

  return { publish, broadcast, subscribe, emit, onLive };
}

module.exports = { createRunEventBus };
