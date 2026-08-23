const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('双击 index.html 时自动进入正在运行的本地工作台', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const redirectScript = html.match(/<script id="file-entry-redirect">\s*([\s\S]*?)<\/script>/);
  assert.ok(redirectScript, '应提供双击文件时的安全跳转入口');

  let destination = null;
  const fakeWindow = {
    location: {
      protocol: 'file:',
      replace(url) { destination = url; }
    }
  };
  new Function('window', redirectScript[1])(fakeWindow);
  assert.equal(destination, 'http://127.0.0.1:3456/');
});

test('前端内联脚本保持可解析，可靠性闸门默认不可绕过', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/);
  assert.ok(script, '应找到前端内联脚本');
  assert.doesNotThrow(() => new Function(script[1]));
  assert.match(html, /id="gateCheckbox" checked disabled/);
  assert.match(html, /必须由你确认后再执行/);
  assert.match(html, /id="teamBuilder"/);
  assert.match(html, /添加分身/);
  assert.match(html, /id="teamSuggestBtn"/);
  assert.match(html, /AI 建议团队/);
  assert.match(html, /\/api\/team\/suggest/);
  assert.match(html, /data-appmode="discussion"/);
  assert.match(html, /\/api\/discuss\/import/);
  assert.match(html, /id="workspaceCommand"/);
  assert.match(html, /\/api\/workspace\/command/);
  assert.match(html, /id="controlsToggle"/);
  assert.match(html, /id="controlsPanel"/);
  assert.match(html, /id="sidebarResizer"/);
  assert.match(html, /id="inputResizer"/);
  assert.match(html, /controls-collapsed/);
  assert.match(html, /futureWorkbench\.sidebarWidth/);
  assert.match(html, /futureWorkbench\.inputAreaHeight/);
  assert.match(html, /无法连接本地工作台服务/);
  assert.match(html, /http:\/\/127\.0\.0\.1:3456/);
  assert.match(html, /id="dualStrategy"/);
  assert.match(html, /互相确认（更可靠）/);
  assert.match(html, /chat_agent_message/);
  assert.match(html, /id="contextPanel"/);
  assert.match(html, /\/api\/context\/nodes/);
  assert.match(html, /\/api\/collaborate\/deliver/);
  assert.match(html, /隔离产物等待处理/);
  assert.doesNotMatch(html, /ALLOWED_TAGS: \[[^\]]*'img'/);
  assert.match(html, /expectedPlanHash/);
  assert.match(html, /expectedPatchHash/);
  const collaborationBody = html.match(/async function startCollaboration\(\) \{([\s\S]*?)\n    \}\n\n    function handleCollabEvent/);
  assert.ok(collaborationBody);
  assert.doesNotMatch(collaborationBody[1], /chatArea\.innerHTML = '';/);
  assert.match(html, /function trackActiveRun/);
  assert.match(html, /stopBtn\.classList\.toggle\('show', currentBusy\)/);
  assert.match(html, /session\.lastMode \|\| session\.type/);
  assert.match(html, /应用记忆/);
  assert.match(html, /不保证缓存命中/);
  assert.match(html, /let selectedChatProviders = new Set\(\['claude'\]\)/);
  assert.match(html, /agents: selectedProviders/);
  assert.match(html, /selectedChatProviders\.size >= 2/);
  assert.match(html, /data-agent="all"[^>]*>.*全选/);
  assert.match(html, /所有已选成员本轮都没有成功返回/);
  assert.doesNotMatch(html, /两位成员本轮都没有成功返回/);
  assert.match(html, /case 'chat_complete':[\s\S]*?updateSendBtn\(\)/);
  assert.match(html, /case 'chat_error':[\s\S]*?updateSendBtn\(\)/);
  // 协作模式的所有终态分支也必须恢复按钮状态，避免卡在“进行中…”。
  assert.match(html, /case 'gate':[\s\S]*?updateSendBtn\(\)/);
  assert.match(html, /case 'plan_ready':[\s\S]*?updateSendBtn\(\)/);
  assert.match(html, /case 'delivery_gate':[\s\S]*?updateSendBtn\(\)/);
  assert.match(html, /case 'complete':[\s\S]*?updateSendBtn\(\)/);
  assert.match(html, /case 'error':[\s\S]*?updateSendBtn\(\)/);
  // 多 AI 预检：被跳过的不可用成员必须在界面上明确提示。
  assert.match(html, /skippedProviders/);
  assert.match(html, /已跳过不可用成员/);
  // 轨迹必须来自持久事件，具备搜索、筛选、运行分页和 Provider 可见性说明。
  assert.match(html, /id="traceSearch"/);
  assert.match(html, /id="traceFilters"/);
  assert.match(html, /data-filter="failed"/);
  assert.match(html, /加载更早的运行/);
  assert.match(html, /beforeRunId/);
  assert.match(html, /Provider 未提供细节/);
  assert.match(html, /隐藏思维链和 Provider 未提供的数据不会被猜测补全/);
  assert.match(html, /class="trace-run"/);
  assert.match(html, /class="trace-invocation"/);
  assert.match(html, /updateTraceRunState\(sessionId, data\)/);
  // 大资料必须走二进制分块，不再将文件夹整体转为 Base64 JSON。
  assert.match(html, /100 \* 1024 \* 1024/);
  assert.match(html, /reference-uploads/);
  assert.match(html, /file\.slice\(offset/);
  assert.match(html, /application\/octet-stream/);
  assert.match(html, /本轮实际引用/);
  // 工作目录锁定与少量斜杠命令必须在输入框内可发现。
  assert.match(html, /🔒/);
  assert.match(html, /\/help 查看命令/);
  assert.match(html, /async function runSlashCommand/);
  assert.match(html, /async function submitCurrentInput/);
});
