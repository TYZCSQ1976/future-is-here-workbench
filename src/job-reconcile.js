// 启动对账：检查 JSON 任务投影（session.job）与 SQLite 可靠控制面（runs）的状态是否漂移。
// 只报告不一致，不自动修改状态——自动修复可能掩盖真实故障，交由人工判断。

const ACTIVE_JOB_STATES = new Set(['queued', 'running', 'executing', 'interrupted']);
const ACTIVE_RUN_STATES = new Set(['queued', 'running', 'interrupted']);
// 终态只允许语义等价组互认：succeeded/partial 都表示“完成但有部分失败”，
// failed/dead_letter 都表示“失败”；cancelled 只认 cancelled。
const TERMINAL_COMPAT = {
  succeeded: ['succeeded', 'partial'],
  partial: ['succeeded', 'partial'],
  failed: ['failed', 'dead_letter'],
  dead_letter: ['failed', 'dead_letter'],
  cancelled: ['cancelled']
};

// 中间持久态要求 job 与 run 严格一致；活跃态之间互认；终态按语义等价组互认。
function statesCompatible(jobState, runState) {
  if (jobState === runState) return true;
  const jobActive = ACTIVE_JOB_STATES.has(jobState);
  const runActive = ACTIVE_RUN_STATES.has(runState);
  if (jobActive && runActive) return true;
  const compatible = TERMINAL_COMPAT[jobState];
  return Boolean(compatible && compatible.includes(runState));
}

async function reconcileSessionJobs({ store, stateCenter, log = console.warn }) {
  const findings = [];
  const summaries = await store.listSessions();
  for (const summary of summaries) {
    let session;
    try {
      session = store.getSession(summary.id);
    } catch (_) {
      // 列表接口会跳过损坏文件；对账同样跳过。
      continue;
    }
    const job = session.job;
    if (!job || !job.id) continue;
    // 讨论方案导入产生的任务没有对应运行，属合法场景。
    if (job.kind === 'imported_plan') continue;
    let run;
    try {
      run = stateCenter.getRun(job.id);
    } catch (_) {
      findings.push({ sessionId: session.id, jobId: job.id, issue: 'JOB_WITHOUT_RUN', detail: `任务 ${session.name} 的 job(${job.state}) 在 SQLite 中没有对应运行` });
      continue;
    }
    if (!statesCompatible(job.state, run.state)) {
      findings.push({
        sessionId: session.id,
        jobId: job.id,
        issue: 'JOB_RUN_STATE_MISMATCH',
        detail: `任务 ${session.name} 的 job.state=${job.state} 与 run.state=${run.state} 不一致`
      });
    }
  }
  for (const finding of findings) log(`[对账] ${finding.detail}`);
  return { checked: summaries.length, mismatches: findings };
}

module.exports = { reconcileSessionJobs, statesCompatible };
