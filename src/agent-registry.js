function createAgentRegistry(providerAdapter) {
  async function inspect({ force = false } = {}) {
    const providers = await providerAdapter.probeAll({ force });
    return {
      checkedAt: new Date().toISOString(),
      providers,
      readyCount: providers.filter((item) => item.ready).length,
      degradedCount: providers.filter((item) => !item.ready).length
    };
  }

  function describeRunAgents(stateCenter, runId) {
    return stateCenter.listRunAgents(runId).map((agent) => ({
      ...agent,
      identity: 'logical_team_member',
      providerVisibleToUserOnly: true
    }));
  }

  return { inspect, describeRunAgents };
}

module.exports = { createAgentRegistry };
