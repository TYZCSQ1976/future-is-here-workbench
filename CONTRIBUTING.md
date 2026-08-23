# 参与贡献

感谢你帮助改进“未来已来”。这是一个本地优先的单用户 AI 工作台；贡献必须保持这个边界：使用者在自己的电脑上运行自己的 Provider，不把对话、凭据或工作目录发送到项目维护者。

## 开始开发

1. 使用 Node.js 22.13 或更高版本。
2. 运行 `npm run doctor` 查看本机工具。
3. 运行 `npm test` 和 `npm run check`。
4. 如果要运行安全扫描，使用 `npm run security:scan`；扫描工具按需下载，不需要长期保留 `node_modules/`。

## 提交前检查

- 不要提交 `sessions/`、`.workbench/`、`.env`、`.claude/`、日志或 Provider 凭据。
- 不要把用户输入直接交给 shell。
- 不要绕过方案确认、执行确认和交付确认。
- 新增 AI 输出字段时，同时更新结构化合同、黄金样例和测试。
- 新增持久化状态时，说明版本、迁移、恢复和容量边界。
- 运行 `npm run release:check` 确认公开边界没有被破坏。

## Pull Request

请说明：用户问题、行为变化、失败和恢复路径、测试命令、已知限制，以及是否改变了安全边界。不要在 Issue 或 Pull Request 中粘贴 Token、API Key、完整对话或私密项目文件。
