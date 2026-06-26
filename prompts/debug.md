---
description: Debug a problem with root-cause and validation discipline
argument-hint: "<problem> [scope]"
---

Debug 当前问题，遵循以下流程：

1. 先读取最小相关 rules：`quality.md`；若涉及性能读 `performance.md`，涉及前端读 `frontend.md`，涉及浏览器读 `browser.md`。
2. **复现**：精确描述触发条件和现象。
3. **隔离**：用最小用例或二分法缩小范围。
4. **定位**：查日志、错误栈、相关代码路径，不猜。
5. **根因**：找到直接原因，不停留在表层补丁。
6. **修复**：最小必要改动，附带回归验证。
7. **预防**：判断是否需要补测试、边界检查或可观测性。

问题描述：$1
相关文件/模块：${@:2}
