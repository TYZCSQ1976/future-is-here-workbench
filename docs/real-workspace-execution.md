# 隔离工作区与最终交付决策记录

## 背景

AI 直接修改用户正式目录，即使之后再做验证，也已经造成不可逆污染；多个成员共享同一目录还会产生覆盖和责任不清。用户同时关心 `node_modules` 体积，不能靠复制整个项目实现隔离。

## 决策

真实实施只接受状态干净的 Git 项目，并采用双人工闸门：

```text
只读讨论与结构化审查
→ 用户第一次批准方案
→ 为主笔创建 detached Git worktree（不复制 node_modules）
→ 主笔只在 worktree 写入
→ 其他成员在同一隔离产物上只读验证
→ 服务端生成 changed files、patch hash 和 patch bytes
→ 用户第二次批准交付，或明确丢弃
→ 交付前再次检查正式目录 HEAD 和清洁状态
→ git apply --check 通过后才套用；不提交、不部署
```

浏览器命令栏仍只支持 `pwd`、`cd`、`ls`，不把输入交给 shell。工作目录先经 `realpath`，再限制在 `WORKBENCH_WORKSPACE_ROOTS` 中。Git 调用使用固定命令与参数数组，不使用 shell。

## 完成条件

- 正式工作区在第二次人工批准前保持不变；
- 隔离产物必须产生真实文件变化；
- 所有独立验证者必须通过结构化检查；
- 交付时正式工作区必须仍处于原始 Git revision 且没有新修改；
- `git apply --check` 必须通过；
- 任何失败都不能显示为完成。

## 当前边界

- Git worktree 是代码变更隔离，不是操作系统容器；Claude `acceptEdits` 的权限强度仍低于 Codex workspace-write 沙箱；
- 当前只有一个可写主笔，其余成员只读；多写入者候选补丁和冲突裁决尚未实现；
- worktree 不复制 `node_modules`，因此某些依赖本地安装结果的测试可能无法在隔离目录直接运行，必须如实标记 unknown；
- 空文件的 Git patch 表达和超大二进制补丁需要继续增加专项验收；
- 用户丢弃 worktree 是明确的破坏性决定，界面必须二次确认。
