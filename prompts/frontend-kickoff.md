---
description: Start a frontend task with design authority, tiering, and validation plan
argument-hint: "<task> [target] [style]"
---

前端任务启动清单：

1. 读取最小相关 rules：`frontend.md`；如涉及性能读 `performance.md`，新增结构读 `project-structure.md`，浏览器验证读 `browser.md`。
2. 读取项目中已有的 `DESIGN.md`（如有），并声明 style authority。
3. 判定 `frontend_tier`：L0 / L1-F / L1-V / L2。
4. 检查相关组件、样式 token、路由、状态管理、数据流和验证命令。
5. 视觉任务按需使用 `image_gen` 生成参考图，并用 `image_review` 或浏览器截图确认方向。
6. 输出实现计划：文件变更范围、组件树、数据流、边界状态、验证策略。

任务描述：$1
目标设备：${2:-未指定}
设计风格：${3:-遵循项目 DESIGN.md 或现有风格}
