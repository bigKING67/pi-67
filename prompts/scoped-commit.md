---
description: Prepare a scoped git commit without staging unrelated work
argument-hint: "<scope>"
---

为目标改动做 scoped commit：

1. 读取 `quality.md`，并遵守全局 AGENTS 的 Git / Dirty Worktree 规则。
2. `git status --short` 确认当前改动范围，区分用户已有改动和本任务改动。
3. 只 add 与任务直接相关的文件，禁止 `git add -A`。
4. 提交前运行最小相关验证；若无法验证，说明原因。
5. commit message 格式：`<type>(<scope>): <subject>`
   - type: feat / fix / refactor / style / docs / test / chore
   - scope: 影响的模块/目录
   - subject: 一句话描述，中文或英文均可
6. 不 push，除非用户明确要求。

改动焦点：$ARGUMENTS
