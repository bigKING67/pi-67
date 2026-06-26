<!-- ~/.pi/agent/prompts/scoped-commit.md -->
为目标改动做 scoped commit：

1. `git status --short` 确认当前改动范围。
2. 只 add 与任务直接相关的文件，禁止 `git add -A`。
3. commit message 格式：`<type>(<scope>): <subject>`
   - type: feat / fix / refactor / style / docs / test / chore
   - scope: 影响的模块/目录
   - subject: 一句话描述，中文或英文
4. 不 push（除非用户明确要求）。

改动焦点：{{scope}}
