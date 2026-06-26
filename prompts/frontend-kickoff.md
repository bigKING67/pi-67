<!-- ~/.pi/agent/prompts/frontend-kickoff.md -->
前端任务启动清单：

1. 读取项目中已有的 `DESIGN.md`（如有）。
2. 判定 `frontend_tier`（L0/L1-F/L1-V/L2）。
3. 使用 `image_gen` 生成设计参考图，`image_review` 确认方向。
4. 检查相关组件、样式 token、路由、状态管理。
5. 输出实现计划：文件变更范围、组件树、数据流、验证策略。

任务描述：{{task}}
目标设备：{{target}}
设计风格：{{style}}
