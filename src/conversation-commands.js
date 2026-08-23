const { AppError } = require('./errors');
const { runWorkspaceCommand } = require('./workspace');
const { attachmentStorageUsage } = require('./attachments');

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function createConversationCommands({ store, stateCenter, jobs, sessionReset, referenceLibrary, storageManager = null, backupManager = null, onRestoreRequested = null }) {
  async function execute(sessionId, input) {
    const raw = String(input?.command || '').trim();
    if (!raw.startsWith('/')) throw new AppError(400, 'INVALID_COMMAND', '命令必须以 / 开头');
    if (raw.length > 500) throw new AppError(413, 'COMMAND_TOO_LONG', '命令太长了');
    const [name, ...args] = raw.slice(1).split(/\s+/);
    const command = name.toLowerCase();
    const session = store.getSession(sessionId);

    if (command === 'help') {
      return { command, text: [
        '/new（或 /clear）— 清空本任务的对话、轨迹、缓存和参考资料；保留锁定的工作目录',
        '/status — 查看当前任务与占用空间',
        '/context — 查看下一轮 AI 会继承什么',
        '/pwd — 查看锁定的工作目录',
        '/ls [子目录] — 只读列出工作目录内文件',
        '/files — 查看本任务参考资料',
        '/backup — 创建一份有界恢复快照（最多保留两份）',
        '/backups — 查看可恢复快照',
        '/restore <快照编号> — 确认后登记恢复，并安全停止；再次启动时恢复'
      ].join('\n') };
    }

    if (command === 'new' || command === 'clear') {
      if (input?.confirmed !== true) throw new AppError(409, 'COMMAND_CONFIRMATION_REQUIRED', '清空操作需要再次确认');
      const result = await sessionReset.reset(sessionId);
      return { command, text: `上下文已真正清空；释放参考资料 ${formatBytes(result.cleared.referenceBytes)}、附件 ${formatBytes(result.cleared.attachmentBytes)}。${result.workspace ? '锁定的工作目录已保留。' : ''}`, result };
    }

    if (command === 'backup') {
      if (!backupManager) throw new AppError(503, 'BACKUP_UNAVAILABLE', '当前版本没有启用恢复快照');
      const snapshot = backupManager.create();
      return { command, text: `恢复快照已创建：${snapshot.id}\n实际新增复制数据约 ${formatBytes(snapshot.copiedBytes)}；${snapshot.linkedFiles} 个大文件使用硬链接，没有重复占用同等空间。`, result: snapshot };
    }

    if (command === 'backups') {
      if (!backupManager) throw new AppError(503, 'BACKUP_UNAVAILABLE', '当前版本没有启用恢复快照');
      const snapshots = backupManager.list();
      return { command, text: snapshots.length
        ? snapshots.map((item) => `${item.id}｜${item.createdAt}｜实际复制约 ${formatBytes(item.copiedBytes)}`).join('\n')
        : '当前没有恢复快照。' };
    }

    if (command === 'restore') {
      if (input?.confirmed !== true) throw new AppError(409, 'COMMAND_CONFIRMATION_REQUIRED', '恢复操作需要再次确认');
      if (!args[0]) throw new AppError(400, 'BACKUP_ID_REQUIRED', '请输入 /restore 后面的快照编号');
      if (!backupManager) throw new AppError(503, 'BACKUP_UNAVAILABLE', '当前版本没有启用恢复快照');
      const result = backupManager.requestRestore(args[0]);
      onRestoreRequested?.(result);
      return { command, text: `已登记恢复 ${result.id}。工作台正在安全停止；请稍后重新双击“开始”，恢复会在数据库打开前完成。`, result };
    }

    const uploads = referenceLibrary.list(sessionId);
    const referenceBytes = uploads.reduce((sum, item) => sum + Number(item.totalBytes || 0), 0);
    const attachmentUsage = attachmentStorageUsage(sessionId);
    if (command === 'status') {
      const active = jobs.isActive(sessionId) || Boolean(stateCenter.listRuns({ sessionId, states: ['queued', 'running', 'interrupted'] })[0]);
      const storage = storageManager?.usage?.();
      const storageLines = storage ? [
        `工作台本地占用：${formatBytes(storage.totalBytes)}${storage.warning ? '（已到提醒线，请检查不再需要的任务或资料）' : ''}`,
        `其中：会话 ${formatBytes(storage.breakdown.sessions)}、状态与轨迹 ${formatBytes(storage.breakdown.database)}、参考资料与附件 ${formatBytes(storage.breakdown.references + storage.breakdown.attachments)}、隔离工作区 ${formatBytes(storage.breakdown.worktrees)}、日志与临时文件 ${formatBytes(storage.breakdown.logs + storage.breakdown.providerTemp)}`
      ] : [];
      return { command, text: [
        `模式：${{ chat: '对话', discussion: '讨论', collab: '协作' }[session.lastMode] || session.lastMode}`,
        `工作目录：${session.workspace?.path || '未绑定'}`,
        `对话消息：${session.messages.length} 条`,
        `参考资料：${uploads.length} 组，${formatBytes(referenceBytes)} / 100MB`,
        `图片与旧版附件：${attachmentUsage.files} 个，${formatBytes(attachmentUsage.bytes)} / 50MB`,
        `运行状态：${active ? '运行中' : session.job?.state || '空闲'}`,
        ...storageLines
      ].join('\n') };
    }

    if (command === 'context') {
      const modeCounts = { chat: 0, discussion: 0, collab: 0 };
      for (const message of session.messages) if (modeCounts[message.interactionMode] !== undefined) modeCounts[message.interactionMode] += 1;
      const memory = stateCenter.resolveContext({ workspacePath: session.workspace?.path || '', query: '' }).nodes;
      return { command, text: [
        '三种模式共享同一任务的事实与最近对话；每条历史都会标明来自对话、讨论还是协作。讨论方案与协作审批另行保存，不会伪装成普通回答。',
        `最近消息：对话 ${modeCounts.chat}、讨论 ${modeCounts.discussion}、协作 ${modeCounts.collab}（送给 AI 时最多取最近 20 条）`,
        `已批准长期记忆：${memory.length} 条`,
        `参考资料：${uploads.reduce((sum, item) => sum + item.fileCount, 0)} 个文件；每轮只检索相关片段，最多约 60,000 字符`,
        `工作目录：${session.workspace?.path || '未绑定'}`
      ].join('\n') };
    }

    if (command === 'pwd') {
      const result = runWorkspaceCommand('pwd', session.workspace?.path || null);
      return { command, text: result.output };
    }

    if (command === 'ls') {
      const result = runWorkspaceCommand(`ls${args.length ? ` ${args.join(' ')}` : ''}`, session.workspace?.path || null);
      return { command, text: `${result.listing.path}\n${result.output}${result.listing.truncated ? '\n（仅显示前 200 项）' : ''}` };
    }

    if (command === 'files') {
      if (!uploads.length) return { command, text: '当前任务没有参考资料。' };
      return { command, text: uploads.map((item) => {
        const parsed = `${item.parsedFileCount} 可解析`;
        const skipped = item.failedFileCount + item.unsupportedFileCount;
        return `${item.name}：${item.fileCount} 个文件，${formatBytes(item.totalBytes)}，${parsed}${skipped ? `，${skipped} 个未解析` : ''}`;
      }).join('\n') };
    }

    throw new AppError(400, 'UNKNOWN_COMMAND', `不认识 /${command}。输入 /help 查看可用命令`);
  }

  return { execute };
}

module.exports = { createConversationCommands, formatBytes };
