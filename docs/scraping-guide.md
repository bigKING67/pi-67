# 浏览器采集场景最佳实践

> 基于巨量云图 200 页行业素材批量采集的经验总结

---

## 核心原则

1. **长任务用 `browser_job_ops`，并拆成可在 120s 内完成的小批次**
2. **工具调用之间用 `browser_wait` 验证页面状态，不把固定 sleep 当成完成证据**
3. **分页由 `browser_execute_js` 执行动作、`browser_wait` 验证结果；当前没有独立 paginate 工具**
4. **断点只写 scoped localStorage key；用 `js_reverse_get_storage` 或 `browser_execute_js` 定点读取**
5. **iframe/微前端先建立 frame tree；跨域 frame 只使用 degraded metadata，不推断内部 DOM**

---

## 采集前 Checklist

### 页面准备（手动，一次性）

- [ ] 日期范围设置正确（月初 → 月末）
- [ ] 品牌筛选勾选完整（8 个指定品牌，不要多也不要少）
- [ ] 品类 / 投放类型 / 内容类型设置正确
- [ ] 排序方式确认（默认曝光量 TOP1000）
- [ ] 自定义指标已添加（3S 完播率 / 5S 完播率 / 互动率 / PVR）
- [ ] 列表显示模式是「表格」而不是「卡片」
- [ ] **绝对不要点 location.reload()**（会重置所有筛选条件）

### 验证筛选条件

```javascript
// 在 browser_execute_js 中执行：
var inputs = document.querySelectorAll('input[type="text"]');
Array.from(inputs).slice(0, 12).forEach(function(el, i) {
  console.log(i + ': ' + el.value.substring(0, 80));
});
// 检查输出：
//   - 日期: 2026-05-01 ~ 2026-05-31
//   - 品牌: 指定品牌（不是"行业核心品牌"）
//   - 内容类型: 引流短视频
```

---

## 采集模式选择

| 数据规模 | 页面机制 | 推荐模式 |
|----------|----------|----------|
| <50 页，每页 <20 条 | 简单翻页 | `browser_execute_js`；仍需显式等待和超时 |
| 50-200 页 | SPA 翻页（URL 不变） | `browser_job_ops` + 小批次（建议 5-10 页/批） |
| 200+ 页 | SPA + 虚拟滚动 | `browser_job_ops` + 断点续传；按实测调整批次 |
| 无限滚动 | scroll load | `browser_job_ops` + 有终止条件的 scroll 批次 |

### 模式 A：一次性 execute_js（小规模）

```
browser_execute_js({
  script: <采集脚本>,
  timeout_ms: 120000
})
```

**适用**：页数 < 50，每页数据获取 < 2s  
**不适用**：总耗时 > 120s 的任务

### 模式 B：browser_job_ops（中大规模，推荐）

```
// 启动。script 必须返回 Promise/结果，不能只安排 setTimeout 后立即返回。
browser_job_ops({
  action: "start",
  title: "scrape pages 1-10",
  workspace_key: "<workspace_key>",
  task_id: "<task_id>",
  script: <单批采集脚本>,
  timeout_ms: 120000,
  prepare_run: true
})
→ { ok: true, job: { job_id: "abc123", durable: true, ... } }

// 查询状态；只按需要轮询，不做高频空转。
browser_job_ops({ action: "status", job_id: "abc123" })

// 终态后获取结果。
browser_job_ops({ action: "result", job_id: "abc123" })
```

有效 run-backed job 会返回 `durable:true` 并把 checkpoint 写到 browser67 的
run 目录；这只保证 job 元数据/结果可恢复，业务数据仍应写入单一、明确的
localStorage key。`cancel` 对已经进入 `Runtime.evaluate` 的脚本是 intent-only，
必须检查 `abort_supported` 和 `cancel_outcome`，不能假定页面脚本已经停止。

### 模式 C：分批 execute_js（小规模同步回退）

```
// Batch 1: pages 1-20
browser_execute_js({ script: <脚本>, timeout_ms: 60000 })
// 超时不代表本批完整；只读取 scoped checkpoint，按最后成功页续跑。
// 检查进度：
browser_execute_js({ script: <progress.js>, timeout_ms: 5000 })

// Batch 2: pages 21-40（脚本自动从断点续传）
browser_execute_js({ script: <脚本>, timeout_ms: 60000 })
// 重复直到 200/200
```

---

## 翻页最佳实践

### 当前工具合同

```
// 1. 执行一次明确的翻页动作，并返回动作前的页码/首行签名。
browser_execute_js({
  script: <click-next-and-return-previous-state>,
  timeout_ms: 5000
})

// 2. 验证页码或首行签名已改变且新行已渲染。
browser_wait({
  type: "function",
  predicate: <page-changed-and-rows-ready-predicate>,
  interval_ms: 100,
  timeout_ms: 10000
})
```

在单个 `browser_job_ops` 脚本内部无法回调 MCP 工具；此时脚本必须使用有
deadline 的 DOM 轮询，并让顶层 Promise 在单批完成或失败时 resolve/reject。
不要只注册 timer 后立即返回，否则 job 会过早进入终态。

### 页面内批次翻页

```javascript
async function gotoPage(target, deadline) {
  while (getCurrentPage() < target && Date.now() < deadline) {
    var previous = getCurrentPage();
    if (!clickNextPage()) throw new Error('next_page_not_found');
    var changed = await waitFor(function() {
      return getCurrentPage() !== previous && getRows().length > 0;
    }, Math.min(10000, deadline - Date.now()));
    if (!changed) throw new Error('page_change_timeout');
  }
}
```

### 常见翻页陷阱

| 陷阱 | 表现 | 解决 |
|------|------|------|
| 双 pager | 同一页出现两组分页器 | 限定可见 pager root，或明确选择最后一组可见分页器 |
| 省略号 | 目标页不在可见 pager 内 | 优先点 next 控件逐页推进；不要把省略号当数据页 |
| 表格未渲染 | pager 变了但表格还是老数据 | 用 `browser_wait(type:"function")` 同时验证页码/首行签名和 rows |
| 后期变慢 | 前 50 页 500ms/页，后 50 页 2s/页 | 动态适应当前页渲染速度 |

---

## CDN 直链获取策略

### 策略优先级

1. **API 拦截**（最优）→ 拦截 `BatchGetPlayVideoInfoTurtle` 等 API，从 JSON response 提取
2. **DOM 提取**（次优）→ `querySelectorAll('video[src*="oceanengine"]')`
3. **innerHTML 解析**（兜底）→ 从页面 HTML 源码中正则匹配

### API 拦截要点

```javascript
// 首屏请求不能靠普通页面执行补抓。用 js-reverse 记录 preload 语义：
js_reverse_inject_preload_script({
  code: `
    var origFetch = window.fetch;
    window.fetch = function(url, opts) {
      var p = origFetch.apply(this, arguments);
      if (url.indexOf('BatchGetPlayVideoInfoTurtle') > -1) {
        p.then(r => r.clone().json()).then(j => {
          window._cdnQueue = (j.data||[]).map(i => i.videoUrl);
        });
      }
      return p;
    };
  `
});
```

`js_reverse_inject_preload_script` 会返回 `preload_semantics`。它可以在当前
document 执行并记录下一次导航的注入意图，但不自动等于 true
`document_start`；真正的首脚本注入需要 extension content script 或 remote
CDP `Page.addScriptToEvaluateOnNewDocument` 路径。

### 微前端注意事项

Garfish/qiankun 子应用可能缓存 fetch/XHR 引用，晚注入 hook 无效。先用
`js_reverse_list_frames` 建 frame tree 并记录 `frame_id`、`frame_path`、
`origin` 和 `same_origin/degraded_mode`。same-origin frame 可继续定点观察；
cross-origin、closed shadow root 或 sandbox 场景只报告可见边界，不能把未观察到
的数据写成“已覆盖”。DOM 提取可以作为显式降级，但必须单独报告覆盖率和缺口。

---

## 数据质量保证

### 采集时检查

```javascript
// 每页采集后验证：
var rows = document.querySelectorAll('.content-ecom-Table-Row');
console.log('Rows: ' + rows.length + ' (expected: 6, including header)');

// 检查品牌是否在目标列表内
var brandsInRow = rows[1]?.textContent.match(/(卡诗|欧莱雅|韩束|OKCS|EHD|Spes|馥绿德雅|Off.?relax)/gi);
if (!brandsInRow) console.warn('Brand filter may be wrong!');
```

### 导出前检查

```javascript
// 排名完整性
var ranks = data.map(r => parseInt(r['排名']));
var missing = [];
for (var i = 1; i <= 1000; i++) if (!ranks.includes(i)) missing.push(i);
console.log('Missing ranks: ' + missing.join(','));

// CDN 覆盖率
var withCDN = data.filter(r => r['CDN直链'] && r['CDN直链'].length > 20);
console.log('CDN coverage: ' + (withCDN.length / data.length * 100).toFixed(1) + '%');

// 品牌过滤验证
var brands = new Set();
data.forEach(r => {
  var m = r['视频内容']?.match(/#(卡诗|欧莱雅PRO|韩束|OKCS|EHD|Spes|馥绿德雅|Off.?relax)/gi);
  if (m) m.forEach(b => brands.add(b.replace('#','')));
});
console.log('Brands found: ' + [...brands].join(', '));
```

---

## 故障恢复

| 故障 | 恢复方式 |
|------|----------|
| browser_execute_js / job 超时 | 定点读取 checkpoint key；确认脚本是否仍在运行后再续跑，避免重复任务 |
| transport 断开 | 先用 `browser_transport_health` 区分 ws/link，再决定是否重试 |
| 页面筛选条件丢失 | 只能手动重设（没有程序化方式恢复） |
| 翻到一半浏览器关闭 | 重新核对筛选条件和当前页，再从 checkpoint 开始下一批 |
| CDN 某页缺失 | 执行 CDN 回填脚本（只扫缺失页） |
| 数据有非目标品牌 | 筛选条件被污染，清理后重采 |

---

## 单一历史场景的性能参考

以下数字来自文首所述采集任务，不是 browser67 的通用 SLA。页面规模、接口
延迟、渲染方式和批次大小变化后必须重新测量；单批应留在 120s 工具上限内。

| 操作 | 耗时 | 说明 |
|------|------|------|
| 翻 1 页 + 采集 5 行 | 550-700ms | SPA 翻页，正常情况 |
| 翻 1 页（后期变慢） | 2-5s | 页面/后端响应慢 |
| 200 页全部采集 | 3-5 分钟 | 含翻页 + 采集 + localStorage 写入 |
| CDN API 拦截安装 | 即时 | 不需要额外时间 |
| Blob 下载导出 | < 1s | 1000 条约 1MB |
