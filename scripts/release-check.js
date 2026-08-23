#!/usr/bin/env node

// 发布前检查：确保私密运行数据和本机配置不会进入开源清单。
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
const errors = [];

const forbiddenPublishEntries = ['sessions', '.workbench', 'node_modules', '.claude', '.env'];
for (const entry of packageJson.files || []) {
  if (forbiddenPublishEntries.some((forbidden) => entry === forbidden || entry.startsWith(`${forbidden}/`))) {
    errors.push(`package.json files 不得包含私密或运行目录：${entry}`);
  }
}

for (const required of ['sessions/', '.workbench/', 'node_modules/', '.claude/', '.env', '!.env.example']) {
  if (!gitignore.split(/\r?\n/).some((line) => line.trim() === required)) {
    errors.push(`.gitignore 缺少边界规则：${required}`);
  }
}

for (const requiredFile of ['LICENSE', 'README.md', 'SECURITY.md', '.env.example']) {
  if (!fs.existsSync(path.join(root, requiredFile))) errors.push(`缺少公开仓库文件：${requiredFile}`);
}

for (const privateFile of ['.env', 'WORKBENCH_TOKEN', 'credentials.json']) {
  if (fs.existsSync(path.join(root, privateFile))) errors.push(`发现不应发布的本地凭据文件：${privateFile}`);
}

if (packageJson.private !== true) {
  errors.push('package.json 必须保持 private=true，避免误发布到 npm；GitHub 开源不受影响。');
}

if (errors.length > 0) {
  console.error('❌ 发布边界检查失败：');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log('✅ 发布边界通过：运行数据、依赖、个人配置和凭据不会进入公开清单。');
}
