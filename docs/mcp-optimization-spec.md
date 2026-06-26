# js-reverse + TMWD MCP 全链路优化实施规范

> Version: v1.0
> Target: js-reverse MCP server + TMWD MCP server + browser extension
> 基于巨量云图 200 页批采实战反馈

---

## 一、browser_execute_js：长任务与超时语义

### 1.1 问题

- `executeTmwdJs` 存在 `Math.min(20_000, timeout_ms + 2_000)` 截断，传 `timeout_ms: 120000` 实际 ~20s 判超
- 超时后统一返回 `status: "failed"`，但脚本通常在后台继续运行
- 每次返回携带 ~2KB sessions/diff/transport_attempts 噪音

### 1.2 修改

**移除 20s hard cap**：
```
executeTmwdJs 不再限制超时上限。
轻量操作（probe/list/session）保留 5s 默认超时。
用户脚本执行尊重传入的 timeout_ms。
```

**四种返回状态**：
```json
{ "status": "success" }         // 正常完成
{ "status": "failed" }          // 真失败（脚本异常、权限）
{ "status": "timeout" }          // 超时且无法证明后台运行
{ "status": "background_running" }  // 超时但检测到后台活动
```

**background_running 返回**：
```json
{
  "status": "background_running",
  "timed_out": true,
  "background_task_id": "bt_abc123",
  "progress": { "pages": 45, "records": 225 },
  "progress_source": "localStorage",
  "warning": "Script timed out at host boundary but page-side progress indicates it is still running"
}
```

**新增入参**：
```
progress_storage_key?: string   // 超时后读取的 localStorage key
progress_expression?: string    // 超时后执行的短表达式
compact: boolean                 // 便捷 alias for diagnostics:"compact"
diagnostics: "full" | "compact"  // full 保持现有兼容
```

**compact 返回**：只保留 `status, js_return, error, transport, transport_summary, tab_id, session_id, progress, background_task_id`

**transport_summary**（无论 full/compact 都返回）：
```json
{
  "selected_transport": "tmwd_ws",
  "fallback_attempted": true,
  "fallback_succeeded": false,
  "health_hint": "degraded",
  "last_error_code": "NO_EXTENSION",
  "recommended_next_action": "Use browser_transport_health to diagnose"
}
```

### 1.3 测试用例

| # | 场景 | 预期 |
|---|------|------|
| T1 | 轻量脚本 50ms 完成 | status: "success", transport: "tmwd_ws" |
| T2 | 长脚本 timeout_ms: 120000 执行 90s | status: "success"（不被 20s 截断） |
| T3 | 长脚本 120s 超时但有 localStorage 进度 | status: "background_running", progress: {...} |
| T4 | 脚本语法错误 | status: "failed", error_code: "EXECUTION_ERROR" |
| T5 | compact: true | 返回无 sessions/diff/transport_attempts |
| T6 | full 模式（默认） | 兼容现有字段不变 |

---

## 二、browser_background_task：长任务正式解耦

### 2.1 新增工具

```
browser_background_task.start({
  code: string,
  task_id?: string,        // 不传自动生成
  storage_key?: string,    // 进度持久化的 localStorage key
  timeout_ms?: number
})
→ { task_id: string, status: "started" }

browser_background_task.status({
  task_id: string
})
→ {
    task_id, status: "running" | "done" | "cancelled" | "error",
    progress: { pages: 45, records: 225 },
    result?: any,
    error?: string,
    started_at: ISO8601,
    updated_at: ISO8601
  }

browser_background_task.cancel({ task_id: string })
→ { status: "cancelled" }

browser_background_task.list()
→ { tasks: [{ task_id, status, started_at }, ...] }
```

### 2.2 页面侧实现

```javascript
// 注入到页面的 background task registry
window.__TMWD_BG_TASKS__ = {};

function __tmwd_register_task(taskId) {
  window.__TMWD_BG_TASKS__[taskId] = {
    status: 'running',
    started_at: Date.now(),
    updated_at: Date.now(),
    progress: null,
    result: null,
    error: null,
    cancel_requested: false
  };
}

function __tmwd_update_progress(taskId, progress) {
  var t = window.__TMWD_BG_TASKS__[taskId];
  if (t) { t.progress = progress; t.updated_at = Date.now(); }
}

function __tmwd_complete_task(taskId, result) {
  var t = window.__TMWD_BG_TASKS__[taskId];
  if (t) { t.status = 'done'; t.result = result; t.updated_at = Date.now(); }
}
```

长循环脚本需检查 `cancel_requested` 标记以实现优雅取消。

### 2.3 测试用例

| # | 场景 | 预期 |
|---|------|------|
| T7 | start → status × N → done | 进度递增，最终 status: "done" |
| T8 | start → cancel | status: "cancelled"，脚本停止 |
| T9 | start 后页面关闭 | status 返回 "error" + 页面不可达 |
| T10 | 同一页面并发两个 task | 各自独立，不同 task_id |

---

## 三、browser_transport_health：传输层诊断

### 3.1 新增工具

```
browser_transport_health({ timeout_ms?: 5000 })
→ {
    status: "ok" | "degraded" | "down",
    ws: {
      reachable: boolean,
      extension_connected: boolean,
      latency_ms: number,
      error_code: string | null
    },
    link: {
      reachable: boolean,
      latency_ms: number,
      error_code: string | null
    },
    selected_transport: "tmwd_ws" | "tmwd_link",
    session_count: number,
    selected_session_id: string | null,
    recommendation: string
  }
```

### 3.2 测试用例

| # | 场景 | 预期 |
|---|------|------|
| T11 | ws 正常 | status: "ok", ws.reachable: true |
| T12 | ws closed | status: "degraded", ws.error_code: "NO_EXTENSION" |
| T13 | 双通道都挂 | status: "down", recommendation: "重连浏览器" |
| T14 | link 超时 | link.reachable: false, recommendation: "使用 ws" |

---

## 四、错误分类体系

### 4.1 分类

| 级别 | 含义 | recoverable | 示例 |
|------|------|-------------|------|
| `E_TRANSPORT` | 传输层问题 | true | ws closed, link timeout, NO_EXTENSION |
| `E_EXECUTION` | 脚本执行问题 | false（除非重试） | 语法错误、权限拒绝 |
| `E_PAGE` | 页面状态问题 | false | 目标 selector 不存在 |
| `E_USER` | 调用方参数问题 | false | session_id 无效 |

### 4.2 返回格式

```json
{
  "error": "...",
  "error_taxonomy": {
    "level": "E_TRANSPORT",
    "detail": "ws_closed",
    "recoverable": true,
    "suggested_action": "Auto-retry in 1s or use browser_transport_health"
  }
}
```

---

## 五、browser_wait：语义化等待

### 5.1 新增工具

```
browser_wait({
  condition: "selector_visible" | "selector_text" | "function_truthy" | "network_idle" | "dom_stable",
  selector?: string,
  text?: string,
  expression?: string,
  timeout_ms: number,
  poll_ms?: 200,
  stable_ms?: 500
})
→ {
    status: "success" | "timeout",
    elapsed_ms: number,
    matched: boolean,
    last_observed?: any
  }
```

### 5.2 测试用例

| # | 场景 | 预期 |
|---|------|------|
| T15 | selector_visible 存在 | status: "success", matched: true |
| T16 | selector_visible 超时 | status: "timeout", matched: false |
| T17 | selector_text ".page" = "13" | 轮询到匹配或超时 |
| T18 | network_idle | degraded: true（无 preload 时） |

---

## 六、browser_paginate：分页导航抽象

### 6.1 新增工具

```
browser_paginate({
  target_page: number,
  pager_root_selector: string,
  page_button_selector: string,
  next_selector?: string,
  ellipsis_selector?: string,
  content_selector: string,
  loading_selector?: string,
  pager_strategy: "visible_last" | "visible_first",
  max_steps: number,
  wait_ms?: 800
})
→ {
    status: "success" | "timeout" | "not_found",
    target_page: 13,
    current_page: 13,
    click_path: ["2","3","4","...","12","13"],
    content_stable: true,
    elapsed_ms: 12500
  }
```

行为：
- 自动双 pager 选择（`pager_strategy: "visible_last"`）
- 目标页不可见 → 点击省略号展开
- 每次点击后等待 content_selector fingerprint 变化 + DOM stable

### 6.2 测试用例

| # | 场景 | 预期 |
|---|------|------|
| T19 | 从 p1 翻到 p13（连续 pager） | status: "success", click_path: 12 steps |
| T20 | 从 p200 翻到 p13（双 pager + 省略号） | 自动处理回溯 |
| T21 | 目标页不存在（总页 100，要 150） | status: "not_found" |
| T22 | 超时（渲染太慢） | status: "timeout", current_page 部分进展 |

---

## 七、get_local_storage：直接读存储

### 7.1 新增工具

```
get_local_storage({ key: "_scrape_fv2" })
→ { found: true, value: "...", truncated: false }

get_local_storage({ prefix: "_scrape_", max_value_chars: 500 })
→ { found: true, keys: ["_scrape_fv2", "_scrape_meta2"], values: {...} }
```

### 7.2 测试用例

| # | 场景 | 预期 |
|---|------|------|
| T23 | key 存在 | found: true, value 返回 |
| T24 | key 不存在 | found: false |
| T25 | prefix 匹配 | 返回所有匹配 key 和值 |
| T26 | 值太大截断 | truncated: true |

---

## 八、微前端检测与注入

### 8.1 detect_microfrontends

```
js_reverse_detect_microfrontends()
→ {
    detected: true,
    frameworks: [{
      name: "garfish",
      apps: [
        { name: "ecom_content", container_selector: "...", entry_url: "...", same_origin: true }
      ],
      confidence: "high"
    }]
  }
```

检测方式：
1. `window.Garfish !== undefined`
2. `window.__POWERED_BY_QIANKUN__ !== undefined`
3. performance.getEntriesByType('resource') 中匹配子应用 JS entry
4. DOM shadow container 特征（garfish_app_for_*, modern_sub_app_container_*）

### 8.2 inject_preload_script（重建）

```
js_reverse_inject_preload_script({
  id: string,
  code: string,
  run_at: "document_start",     // 必须是 document_start 才能覆盖子应用
  world: "MAIN",
  persist: true,
  verify: true,
  reload: true                   // 注入后自动 reload 使生效
})
→ {
    injected: true,
    verified: true,
    degraded: false,
    verification: { marker_found: true, marker: "window.__preload_hook_installed" }
  }
```

实现：
1. 优先使用 Chrome extension content script manifest 注册
2. MAIN world 不可用 → 用 document_start content script loader 注入 `<script>` 到 MAIN world
3. `verify: true` → 注入后 `browser_execute_js` 检查 marker
4. `degraded: true` 时必须返回 `degraded_reason`

### 8.3 execute_in_subapp

```
js_reverse_execute_in_subapp({
  app_name?: string,
  container_selector?: string,
  code: string
})
→ {
    executed: true,
    context: "main_window" | "iframe" | "sandbox",
    late_hook_warning?: true,
    degraded_reason?: string
  }
```

### 8.4 测试用例

| # | 场景 | 预期 |
|---|------|------|
| T27 | Garfish 页面 | detected: true, frameworks[0].name: "garfish" |
| T28 | 普通页面 | detected: false |
| T29 | document_start preload MAIN world | verified: true, marker 存在 |
| T30 | 子应用已缓存 fetch 引用 | late_hook_warning: true |
| T31 | same-origin iframe execute | context: "iframe", executed: true |
| T32 | cross-origin iframe | executed: false, degraded_reason 明确 |

---

## 九、browser_interact：统一交互

### 9.1 新增工具

```
browser_interact({
  action: "click" | "hover" | "type" | "press",
  selector: ".content-ecom-pager-item",
  trusted?: false,       // true → native_input 坐标点击
  text?: string,
  key?: string,
  wait_after_ms?: 300
})
```

`trusted: true` 时：`getBoundingClientRect()` → screen coordinates → `browser_native_input`。

---

## 十、实施顺序

```
Phase 1 (急停血)
  ├── §1 超时语义修正    ← 最高优先级，每次操作都受影响
  ├── §3 transport_health  ← 同步做，与 §1 协同
  ├── §4 错误分类体系      ← 依赖 §1 的 status 扩展
  └── §7 get_local_storage ← 低成本高收益

Phase 2 (建能力)
  ├── §2 background_task   ← 依赖 §1 完成
  ├── §5 browser_wait      ← 无依赖
  ├── §6 browser_paginate  ← 依赖 §5
  └── §9 browser_interact  ← 无依赖

Phase 3 (穿透)
  ├── §8.1 detect_microfrontends
  ├── §8.2 inject_preload_script
  └── §8.3 execute_in_subapp

Phase 4 (治理)
  ├── 模板库补完
  ├── 工具速查表
  └── 目录规范
```

---

## 十一、验证最终目标

用巨量云图同一套筛选条件全流程回归：

```
1. check_browser_health           → transport: ok
2. detect_microfrontends           → Garfish detected, ecom_content app
3. inject_preload_script(cdn_hook) → verified: true
4. background_task.start(scrape)   → task_id: "bt_001"
5. background_task.status × N      → pages: 45/200 → 200/200
6. get_local_storage("_scrape_fv2") → 1000 records
7. browser_paginate(target: 13)    → click_path: 12 steps, stable
8. browser_wait(selector_visible)  → 翻页后稳定，不用 setTimeout(800)
9. browser_transport_health        → ws: ok, link: ok
10. [断 ws] execute_js             → fallback → transport_summary 显示成功
11. [断 ws] execute_js, compact:true → 返回 ~300B，无噪音
12. merge_export.js 导出            → 1000 条, CDN ≥ 95%
```

目标覆盖率：

| 指标 | 现在 | 目标 |
|------|------|------|
| 超时报错次数（200 页采集） | ~15 次 | 0 次（background_task） |
| CDN 覆盖率 | 95-100% | ≥ 98%（preload hook） |
| 翻页等待方式 | setTimeout(800) | browser_wait + paginate |
| 单次返回噪音（compact） | ~3KB | ~300B |
| 传输故障恢复 | 手动 | 自动 fallback |
