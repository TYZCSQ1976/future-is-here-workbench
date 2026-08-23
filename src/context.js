const config = require('./config');

function truncate(text, max) {
  const value = String(text || '');
  return value.length <= max ? value : `${value.slice(0, max)}\n（后续内容已截断）`;
}

function buildChatContext(messages, newMessage) {
  const recent = (messages || []).slice(-config.MAX_CONTEXT_MESSAGES);
  let prompt = recent.length ? '以下是之前的对话记录，请基于上下文继续对话：\n\n' : '';
  if ((messages || []).length > config.MAX_CONTEXT_MESSAGES) prompt += '（更早的记录已省略）\n\n';
  for (const msg of recent) {
    const mode = { chat: '对话', discussion: '讨论', collab: '协作' }[msg.interactionMode] || '历史';
    if (msg.role === 'user') prompt += `用户（${mode}）: ${truncate(msg.text, 8_000)}\n\n`;
    if (msg.role === 'ai') {
      const speaker = msg.memberName || (msg.chatPhase === 'cross_check' ? '团队复核意见' : '团队成员');
      prompt += `${speaker}（${mode}）: ${truncate(msg.text, 12_000)}\n\n`;
    }
  }
  prompt += `用户: ${newMessage}`;
  return truncate(prompt, config.MAX_CONTEXT_CHARS);
}

module.exports = { buildChatContext, truncate };
