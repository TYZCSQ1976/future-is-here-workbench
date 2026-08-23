#!/usr/bin/env node

// 发布给新用户的环境自检：缺少某个 Provider 不阻止工作台启动，只给出明确提示。
const { execFileSync } = require('node:child_process');
const process = require('node:process');

const requiredMajor = 22;
const major = Number.parseInt(process.versions.node.split('.')[0], 10);
let failed = false;

console.log(`Node.js: ${process.versions.node}`);
if (major < requiredMajor) {
  console.error(`❌ 需要 Node.js ${requiredMajor} 或更高版本。`);
  failed = true;
} else {
  console.log(`✅ Node.js 版本满足要求（>= ${requiredMajor}）。`);
}

function checkCommand(name, required = false) {
  try {
    const version = execFileSync('sh', ['-lc', `command -v ${name} && ${name} --version 2>/dev/null | head -n 1`], { encoding: 'utf8' }).trim();
    console.log(`✅ ${name}: ${version || '已找到'}`);
  } catch (_) {
    console.log(`${required ? '❌' : 'ℹ️'} ${name}: 未找到${required ? '（需要安装）' : '（可选，相关功能会跳过）'}`);
    if (required) failed = true;
  }
}

checkCommand('git', true);
checkCommand('claude');
checkCommand('codex');
checkCommand('dsh');
checkCommand('pdftotext');
checkCommand('pdftoppm');
checkCommand('tesseract');

console.log('');
console.log('安全提示：工作台默认只监听 127.0.0.1；不要把本地端口直接暴露到公网。');
console.log('安全提示：Provider 使用的是你自己电脑上的 CLI 登录状态和额度。');
process.exitCode = failed ? 1 : 0;
