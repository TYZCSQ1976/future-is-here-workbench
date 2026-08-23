const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const config = require('./config');
const { AppError } = require('./errors');
const { resolveWorkspace, isWithin } = require('./workspace');

const SAFE_GIT_DIR = path.join(config.RUNTIME_DIR, 'safe-git');
const SAFE_HOOKS_DIR = path.join(SAFE_GIT_DIR, 'empty-hooks');
const SAFE_GLOBAL_CONFIG = path.join(SAFE_GIT_DIR, 'empty.gitconfig');

function ensureSafeGitEnvironment() {
  fs.mkdirSync(SAFE_HOOKS_DIR, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(SAFE_GLOBAL_CONFIG)) fs.writeFileSync(SAFE_GLOBAL_CONFIG, '', { mode: 0o600 });
}

function runGit(cwd, args, { input = null, allowFailure = false, maxBuffer = 8 * 1024 * 1024, trimOutput = true } = {}) {
  ensureSafeGitEnvironment();
  const result = spawnSync('git', [
    '-c', `core.hooksPath=${SAFE_HOOKS_DIR}`,
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'credential.helper=',
    '-C', cwd,
    ...args
  ], {
    shell: false,
    encoding: 'utf8',
    input,
    maxBuffer,
    env: {
      PATH: process.env.PATH,
      LANG: process.env.LANG || 'en_US.UTF-8',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: SAFE_GLOBAL_CONFIG,
      GIT_TERMINAL_PROMPT: '0'
    }
  });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    const detail = String(result.stderr || result.error?.message || '').trim().slice(-2_000);
    throw new AppError(409, 'GIT_WORKTREE_FAILED', detail ? `Git 隔离操作失败：${detail}` : 'Git 隔离操作失败');
  }
  const output = String(result.stdout || '');
  return trimOutput ? output.trim() : output;
}

function safeSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'member';
}

function createWorktreeManager({ stateCenter, runtimeRoot = path.join(config.RUNTIME_DIR, 'worktrees'), afterPatchApplied = null }) {
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });

  function repositoryInfo(workspacePath) {
    const workspace = resolveWorkspace(workspacePath, workspacePath);
    const repositoryRoot = runGit(workspace, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (!repositoryRoot) {
      throw new AppError(409, 'WORKSPACE_GIT_REQUIRED', '为了可靠隔离，真实执行只支持 Git 项目；请先把项目纳入 Git，讨论和审查仍可正常使用');
    }
    const realRoot = fs.realpathSync(repositoryRoot);
    if (realRoot !== workspace) {
      throw new AppError(409, 'WORKSPACE_GIT_ROOT_REQUIRED', `真实执行必须绑定 Git 项目根目录：${realRoot}`);
    }
    const executableConfig = runGit(realRoot, [
      'config', '--local', '--get-regexp',
      '^(core\\.(hooksPath|fsmonitor)|filter\\..*\\.(clean|smudge|process)|diff\\..*\\.(command|textconv))$'
    ], { allowFailure: true });
    if (executableConfig) {
      throw new AppError(409, 'UNTRUSTED_GIT_CONFIG', '这个仓库包含会执行本机程序的 Git 配置，工作台已拒绝自动执行');
    }
    const status = runGit(realRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status) {
      throw new AppError(409, 'WORKSPACE_NOT_CLEAN', '正式工作区存在尚未提交的修改。为避免覆盖你的文件，请先提交或自行处理这些修改后再执行');
    }
    return { workspace, repositoryRoot: realRoot, revision: runGit(realRoot, ['rev-parse', 'HEAD']) };
  }

  function prepare({ runId, sessionId, agentId, workspacePath }) {
    const existing = stateCenter.listWorkspaceHandles(runId).find((item) => item.agentId === agentId);
    if (existing) return existing;
    const info = repositoryInfo(workspacePath);
    const target = path.join(runtimeRoot, safeSegment(runId), safeSegment(agentId));
    if (!isWithin(target, runtimeRoot)) throw new AppError(500, 'WORKTREE_PATH_INVALID', '隔离工作区路径无效');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    if (fs.existsSync(target)) throw new AppError(409, 'WORKTREE_ALREADY_EXISTS', '隔离工作区目录已经存在，请先处理上一次未完成的运行');
    runGit(info.repositoryRoot, ['worktree', 'add', '--detach', target, info.revision]);
    try {
      return stateCenter.createWorkspaceHandle({
        runId,
        sessionId,
        agentId,
        sourceRoot: info.repositoryRoot,
        isolatedPath: target,
        kind: 'git_worktree',
        state: 'prepared',
        baseRevision: info.revision,
        metadata: { requestedWorkspace: info.workspace }
      });
    } catch (error) {
      // 控制面登记失败时回收刚创建的 worktree，避免留下无人管理的写入目录。
      try { runGit(info.repositoryRoot, ['worktree', 'remove', '--force', target]); } catch (_) {}
      try { runGit(info.repositoryRoot, ['worktree', 'prune']); } catch (_) {}
      throw error;
    }
  }

  function buildPatch(handle) {
    if (!fs.existsSync(handle.isolatedPath)) throw new AppError(409, 'WORKTREE_MISSING', '隔离工作区已经不存在');
    runGit(handle.isolatedPath, ['add', '--intent-to-add', '--all']);
    // 补丁必须基于创建 worktree 时的基准版本，而不是“工作区 vs 索引”：
    // 执行者若违反提示词在隔离区里 git commit，工作区对索引是干净的，
    // 但相对基准版本的差异仍然存在；用工作区状态对比会把已完成的成果判成“无变化”丢弃。
    const patchText = runGit(handle.isolatedPath, ['diff', '--binary', '--no-ext-diff', '--full-index', handle.baseRevision], { maxBuffer: 20 * 1024 * 1024, trimOutput: false });
    const nameStatus = runGit(handle.isolatedPath, ['diff', '--name-status', '--no-ext-diff', handle.baseRevision]);
    const changedFiles = nameStatus.split(/\r?\n/).filter(Boolean).map((line) => {
      const [statusCode, ...paths] = line.split('\t');
      return { status: statusCode.slice(0, 1), path: paths[paths.length - 1] };
    });
    return {
      patchText,
      patchHash: crypto.createHash('sha256').update(patchText).digest('hex'),
      patchBytes: Buffer.byteLength(patchText),
      changedFiles,
      changedCount: changedFiles.length
    };
  }

  function inspect(handleId) {
    const handle = stateCenter.getWorkspaceHandle(handleId);
    const evidence = buildPatch(handle);
    const next = stateCenter.updateWorkspaceHandle(handleId, {
      state: evidence.changedCount > 0 ? 'awaiting_delivery' : 'empty',
      metadata: { ...handle.metadata, evidence: { ...evidence, patchText: undefined } }
    });
    return { handle: next, evidence: { ...evidence, patchText: undefined } };
  }

  function assertSourceUnchanged(handle) {
    const currentRevision = runGit(handle.sourceRoot, ['rev-parse', 'HEAD']);
    if (currentRevision !== handle.baseRevision) {
      throw new AppError(409, 'WORKSPACE_BASE_CHANGED', '正式工作区的 Git 版本已变化，不能再安全套用旧产物');
    }
    const status = runGit(handle.sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status) throw new AppError(409, 'WORKSPACE_NOT_CLEAN', '正式工作区在 AI 运行期间出现了新修改，已停止交付以避免覆盖');
  }

  function removeWorktree(handle) {
    if (!isWithin(handle.isolatedPath, runtimeRoot)) throw new AppError(500, 'WORKTREE_PATH_INVALID', '拒绝清理不属于运行目录的路径');
    if (fs.existsSync(handle.isolatedPath)) runGit(handle.sourceRoot, ['worktree', 'remove', '--force', handle.isolatedPath]);
    runGit(handle.sourceRoot, ['worktree', 'prune']);
  }

  function deliver(handleId, expected = {}) {
    const handle = stateCenter.getWorkspaceHandle(handleId);
    if (handle.state !== 'awaiting_delivery') throw new AppError(409, 'WORKTREE_NOT_READY', '隔离产物尚未通过验证或已经处理');
    assertSourceUnchanged(handle);
    const patch = buildPatch(handle);
    if (!patch.changedCount || !patch.patchText) throw new AppError(409, 'WORKTREE_EMPTY', '隔离工作区没有可交付的修改');
    const reviewed = handle.metadata?.evidence;
    if (expected.patchHash !== reviewed?.patchHash || expected.baseRevision !== handle.baseRevision) {
      throw new AppError(409, 'DELIVERY_EVIDENCE_CHANGED', '你确认的补丁或基础版本与当前隔离产物不一致');
    }
    if (!reviewed?.patchHash || reviewed.patchHash !== patch.patchHash || reviewed.patchBytes !== patch.patchBytes) {
      throw new AppError(409, 'WORKTREE_CHANGED_AFTER_REVIEW', '隔离产物在审核后发生了变化，请重新验证并再次确认');
    }
    runGit(handle.sourceRoot, ['apply', '--check', '-'], { input: patch.patchText, maxBuffer: 20 * 1024 * 1024 });
    // 先原子推进到 delivering 再写入正式仓库：若此后 git apply / 状态登记中途失败，
    // 不会把“补丁已经落到正式工作区”误留在 awaiting_delivery，导致重试被
    // WORKSPACE_NOT_CLEAN 挡死、正式仓库永远无法继续交付。
    stateCenter.updateWorkspaceHandle(handleId, {
      state: 'delivering',
      metadata: { ...handle.metadata, deliveringAt: new Date().toISOString() }
    });
    runGit(handle.sourceRoot, ['apply', '--whitespace=nowarn', '-'], { input: patch.patchText, maxBuffer: 20 * 1024 * 1024 });
    // 测试钩子用于精确模拟“补丁已落盘、数据库尚未更新”时进程崩溃；生产环境不传入。
    if (afterPatchApplied) afterPatchApplied(handle, patch);
    let delivered;
    try {
      delivered = stateCenter.updateWorkspaceHandle(handleId, {
        state: 'delivered',
        metadata: { ...handle.metadata, deliveredAt: new Date().toISOString(), evidence: { ...patch, patchText: undefined } }
      });
    } catch (error) {
      // 补丁已真实写入正式仓库，交付事实成立；此时绝不能回退为可重试状态。
      throw new AppError(500, 'DELIVERY_STATE_UPDATE_FAILED', `补丁已应用到正式工作区，但登记交付状态失败：${error.message}；请刷新页面确认最终状态`);
    }
    // 交付状态已落库，隔离目录清理失败只影响磁盘残留，不再影响交付结果。
    try { removeWorktree(handle); } catch (_) {}
    return delivered;
  }

  function discard(handleId) {
    const handle = stateCenter.getWorkspaceHandle(handleId);
    if (['delivered', 'discarded'].includes(handle.state)) return handle;
    removeWorktree(handle);
    return stateCenter.updateWorkspaceHandle(handleId, {
      state: 'discarded',
      metadata: { ...handle.metadata, discardedAt: new Date().toISOString() }
    });
  }

  function reconcileDeliveries() {
    const results = [];
    for (const handle of stateCenter.listWorkspaceHandlesByState(['delivering'])) {
      try {
        const patch = buildPatch(handle);
        const reviewed = handle.metadata?.evidence;
        if (!reviewed?.patchHash || patch.patchHash !== reviewed.patchHash) {
          const updated = stateCenter.updateWorkspaceHandle(handle.id, {
            state: 'reconciliation_required',
            metadata: { ...handle.metadata, reconciliation: { at: new Date().toISOString(), reason: 'ISOLATED_PATCH_CHANGED' } }
          });
          results.push({ handle: updated, disposition: 'manual_review' });
          continue;
        }
        const reverseCheck = runGit(handle.sourceRoot, ['apply', '--reverse', '--check', '-'], {
          input: patch.patchText, allowFailure: true, maxBuffer: 20 * 1024 * 1024
        });
        const sourceStatus = runGit(handle.sourceRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
        const actualPaths = new Set(sourceStatus.split(/\r?\n/).filter(Boolean).map((line) => line
          .replace(/^[ MARCUD?!]{1,2}\s+/, '')
          .replace(/^.* -> /, '')));
        const expectedPaths = new Set((reviewed.changedFiles || []).map((item) => item.path));
        const exactPaths = actualPaths.size === expectedPaths.size && [...actualPaths].every((item) => expectedPaths.has(item));
        if (reverseCheck !== null && exactPaths) {
          const updated = stateCenter.updateWorkspaceHandle(handle.id, {
            state: 'delivered',
            metadata: { ...handle.metadata, deliveredAt: new Date().toISOString(), recoveredAfterRestart: true }
          });
          try { removeWorktree(handle); } catch (_) {}
          results.push({ handle: updated, disposition: 'delivered' });
          continue;
        }
        const forwardCheck = runGit(handle.sourceRoot, ['apply', '--check', '-'], {
          input: patch.patchText, allowFailure: true, maxBuffer: 20 * 1024 * 1024
        });
        if (forwardCheck !== null && !sourceStatus) {
          const updated = stateCenter.updateWorkspaceHandle(handle.id, {
            state: 'awaiting_delivery',
            metadata: { ...handle.metadata, reconciliation: { at: new Date().toISOString(), reason: 'PATCH_NOT_APPLIED' } }
          });
          results.push({ handle: updated, disposition: 'retry_safe' });
          continue;
        }
        const updated = stateCenter.updateWorkspaceHandle(handle.id, {
          state: 'reconciliation_required',
          metadata: { ...handle.metadata, reconciliation: {
            at: new Date().toISOString(), reason: 'SOURCE_STATE_AMBIGUOUS',
            reversePatchApplies: reverseCheck !== null,
            forwardPatchApplies: forwardCheck !== null,
            actualPaths: [...actualPaths], expectedPaths: [...expectedPaths]
          } }
        });
        results.push({ handle: updated, disposition: 'manual_review' });
      } catch (error) {
        results.push({ handle, disposition: 'manual_review', error: { code: error.code || 'DELIVERY_RECONCILE_FAILED', message: error.message } });
      }
    }
    return results;
  }

  return { repositoryInfo, prepare, inspect, deliver, discard, reconcileDeliveries };
}

module.exports = { createWorktreeManager, runGit };
