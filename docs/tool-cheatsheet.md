# js-reverse + TMWD 工具速查表

> 按场景快速找到应该用哪个 MCP Server 的哪个工具

---

## 工具命名约定

```
MCP namespace:      mcp__<server>__<tool_name>
js-reverse 直调:    js_reverse_<tool_name>        (蛇形)
TMWD 直调:         通过 mcp({ tool, server }) 调用 (驼峰)
```

**简单记法：**
- 页面执行 / 交互 / 下载 / 登录态 → **tmwd**
- API 发现 / hook / 签名链路 / 浏览器状态 → **js-reverse**
- 长任务 / 等待 / 分页 → **tmwd**（新增能力）

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
| 诊断 transport 健康度 | `mcp:browser_transport_health` | 新增，ws/link 分别诊断 |
| 导航到 URL | `mcp:browser_tab_ops` | navigate 操作 |

### 页面脚本执行（tmwd）

| 我想做什么 | 工具 | 说明 |
|------------|------|------|
| 在页面执行 JS | `mcp:browser_execute_js` | 传 code 参数 |
| 执行长任务（翻页采集） | `mcp:browser_background_task` | 新增，start/status/cancel |
| 查看长任务进度 | `mcp:browser_background_task.status` | 轮询 |
| 等待元素出现 | `mcp:browser_wait` | 新增，替代 setTimeout |
| 翻页导航 | `mcp:browser_paginate` | 新增，处理双 pager/省略号 |
| 点击/悬停/输入 | `mcp:browser_interact` | 新增，click/hover/type |
| 真实鼠标点击 | `mcp:browser_native_input` | 需要 x/y 坐标 |
| 读 localStorage | `mcp:get_local_storage` | 新增，不写 JS 直接读 |
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
| 检测微前端框架 | `js_reverse_detect_microfrontends` | Garfish/qiankun/single-spa |
| 注入 preload 脚本 | `js_reverse_inject_preload_script` | document_start 注入 |
| 在子应用中执行 | `js_reverse_execute_in_subapp` | 在 iframe/sandbox 中执行 |

### 登录态 / 文件操作（tmwd）

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
3. mcp:browser_background_task.start       → 启动采集脚本
4. mcp:browser_background_task.status × N  → 轮询进度
5. [超时] mcp:get_local_storage            → 直接读 localStorage 确认
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
2. js_reverse_detect_microfrontends        → 检测框架类型
3. js_reverse_inject_preload_script        → document_start 注入
4. js_reverse_execute_in_subapp            → 在子应用内执行
5. [如果不支持 MAIN world]
   → 接受 degraded 结果，或用 network_hook_collect 模板
```
