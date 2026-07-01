# js-reverse + browser67 工具速查表

> 按场景快速找到应该用哪个 MCP Server 的哪个工具

---

## 工具命名约定

```
MCP namespace:      mcp__<server>__<tool_name>
js-reverse 直调:    js_reverse_<tool_name>        (蛇形)
browser67 直调:    通过 mcp({ tool, server }) 调用 (工具 key 当前为 tmwd_browser)
```

**简单记法：**
- 页面执行 / 交互 / 下载 / 登录态 → **browser67**
- API 发现 / hook / 签名链路 / 浏览器状态 → **js-reverse**
- 长任务 / 等待 / 分页 → **browser67**

---

## 按场景查工具

### 启动与健康检查

| 我想做什么 | 工具 | 说明 |
|------------|------|------|
| 检查浏览器能不能用 | `js_reverse_check_browser_health` | 返回 pages 列表、transport 状态 |
| 查看当前开了哪些页面 | `js_reverse_list_pages` | 列出所有 tab |
| 切换到某个页面 | `js_reverse_select_page` | 通过 page_id 选定 |
| 创建新标签页 | `js_reverse_new_page` | 打开新 tab |
| 浏览器关闭/断开后重连 | `js_reverse_check_browser_health` | 自动尝试重连 |
| 诊断 transport 健康度 | `mcp:browser_transport_health` | browser67 preflight，ws/link 分别诊断 |
| 导航到 URL | `mcp:browser_tab_ops` | navigate 操作 |

### 页面脚本执行（browser67）

| 我想做什么 | 工具 | 说明 |
|------------|------|------|
| 在页面执行 JS | `mcp:browser_execute_js` | 传 code 参数 |
| 执行长任务（翻页采集） | `mcp:browser_job_ops` | start/status/result/list/cancel；in-process、durable:false |
| 查看长任务进度 | `mcp:browser_job_ops` | status/result 轮询；cancel 是 best-effort |
| 等待元素出现 | `mcp:browser_wait` | 替代 setTimeout / 固定 sleep |
| 翻页导航 | `mcp:browser_execute_js` + `mcp:browser_wait` | 不声明独立 paginate 工具 |
| 点击/悬停/输入 | `mcp:browser_execute_js` / `mcp:browser_native_input` | 普通 DOM 动作走 JS；需真实输入才用 native |
| 真实鼠标点击 | `mcp:browser_native_input` | 需要 x/y 坐标 |
| 读 localStorage | `js_reverse_get_storage` / `mcp:browser_execute_js` | scoped 读取；不要 dump 全量 storage |
| DOM 截图/提取 | `mcp:browser_extract` | 提取页面内容 |
| 下载文件 | `mcp:browser_download_ops` | save/download |
| 刷新页面 | `mcp:browser_tab_lifecycle` | reload 操作 |

### API 发现与 Hook（js-reverse）

| 我想做什么 | 工具 | 说明 |
|------------|------|------|
| 列出页面脚本 | `js_reverse_list_scripts` | 找到关键 JS 文件 |
| 搜索脚本内容 | `js_reverse_search_in_scripts` | 按关键词搜 |
| 获取脚本源码 | `js_reverse_get_script_source` | 读取单个脚本 |
| 列出网络请求 | `js_reverse_list_network_requests` | 看到所有 API 调用 |
| 获取请求详情 | `js_reverse_get_network_request` | 查看请求/响应 |
| 拦截 fetch/XHR | `js_reverse_inject_hook` | hook 网络请求 |
| Hook 函数 | `js_reverse_hook_function` | hook JS 函数 |
| 检测加密算法 | `js_reverse_detect_crypto` | 找签名/加密函数 |
| 分析目标页面 | `js_reverse_analyze_target` | 一键 DOM+脚本+网络 |
| 代码美化 | `js_reverse_deobfuscate_code` | 反混淆 |

### 微前端专项（js-reverse）

| 我想做什么 | 工具 | 说明 |
|------------|------|------|
| 建 frame tree | `js_reverse_list_frames` | 记录 frame id/url/origin/path；cross-origin 返回 degraded evidence |
| 定位子应用脚本 | `js_reverse_list_scripts` / `js_reverse_search_in_scripts` | 结合 frame、script source、network/runtime marker 判断 |
| 注入 preload 脚本 | `js_reverse_inject_preload_script` | 不是保证 true document_start；区分 current eval / next navigation / extension content script / remote CDP preload |
| 无法 hook 子应用 | `js_reverse_record_reverse_evidence` | 明确 same-origin/cross-origin/sandbox/shadow DOM 限制与证据 |

### 登录态 / 文件操作（browser67）

| 我想做什么 | 工具 | 说明 |
|------------|------|------|
| 保存登录态 | `js_reverse_save_session_state` | 保存 cookies/storage |
| 恢复登录态 | `js_reverse_restore_session_state` | 恢复保存的状态 |
| 读取 cookies/storage | `js_reverse_get_storage` | 读取当前存储 |
| 上传文件 | `mcp:browser_file_ops` | upload |
| 剪贴板 | `mcp:browser_clipboard_ops` | read/write |

### 任务收尾

| 我想做什么 | 工具 | 说明 |
|------------|------|------|
| 清理任务页面 | `js_reverse_finalize_task` | 关闭 managed tabs |
| 导出 session 报告 | `js_reverse_export_session_report` | 导出逆向证据 |

---

## 典型场景工作流

### 场景 A：分页列表批量采集

```
1. js_reverse_check_browser_health         → 确认浏览器就绪
2. js_reverse_select_page                  → 选目标页面
3. mcp:browser_job_ops start              → 启动采集脚本
4. mcp:browser_job_ops status/result × N  → 轮询进度
5. [超时] js_reverse_get_storage 或
   mcp:browser_execute_js(scoped read)    → 读取必要 storage key
6. mcp:browser_execute_js(merge_export)    → 导出 JSON
7. js_reverse_finalize_task                → 清理
```

### 场景 B：API 签名逆向

```
1. js_reverse_select_page                  → 选目标页面
2. js_reverse_analyze_target               → 一键探测
3. js_reverse_search_in_scripts            → 搜签名关键词
4. js_reverse_get_script_source            → 读可疑脚本
5. js_reverse_detect_crypto                → 检测加密
6. js_reverse_hook_function                → hook 签名函数
7. [触发操作] → js_reverse_get_hook_data   → 拿到签名参数
```

### 场景 C：微前端页面注入

```
1. js_reverse_select_page                  → 选目标页面
2. js_reverse_list_frames                  → 建 frame tree
3. js_reverse_list_scripts/search          → 定位子应用脚本/容器线索
4. js_reverse_inject_preload_script        → 首屏采样；不宣称 true document_start
5. [如果 frame/sandbox/shadow DOM 不可 hook]
   → 接受 degraded 结果，或用 network_hook_collect 模板
```
