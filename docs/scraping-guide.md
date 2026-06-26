# 浏览器采集场景最佳实践

> 基于巨量云图 200 页行业素材批量采集的经验总结

---

## 核心原则

1. **长任务用 background_task，不要塞进 execute_js 的 120s 窗口**
2. **等待用 browser_wait，不要 setTimeout 硬编码**
3. **翻页用 browser_paginate，不要手动处理双 pager + 省略号**
4. **存储用 localStorage + get_local_storage，数据不丢可续传**
5. **微前端先 detect，再决定注入策略**

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
| <50 页，每页 <20 条 | 简单翻页 | `browser_execute_js` 一次性 |
| 50-200 页 | SPA 翻页（URL 不变） | `browser_background_task` + 分批 |
| 200+ 页 | SPA + 虚拟滚动 | `browser_background_task` + 小批次（5-10 页/批） |
| 无限滚动 | scroll load | `browser_background_task` + scroll 循环 |

### 模式 A：一次性 execute_js（小规模）

```
browser_execute_js({
  code: <采集脚本>,
  timeout_ms: 120000
})
```

**适用**：页数 < 50，每页数据获取 < 2s  
**不适用**：总耗时 > 120s 的任务

### 模式 B：background_task（中大规模，推荐）

```
// 启动
browser_background_task.start({
  code: <采集脚本>,
  storage_key: '_scrape_fv2'
})
→ { task_id: "abc123", status: "started" }

// 轮询（每 20s）
browser_background_task.status({ task_id: "abc123" })
→ { pages: "45/200", records: 225, cdn_coverage: "78%" }

// 继续轮询直到 status: "done"
```

### 模式 C：分批 execute_js（无 background_task 时的回退）

```
// Batch 1: pages 1-20
browser_execute_js({ code: <脚本>, timeout_ms: 60000 })
// 超时？没关系，数据在 localStorage 里。
// 检查进度
browser_execute_js({ code: <progress.js>, timeout_ms: 5000 })

// Batch 2: pages 21-40（脚本自动从断点续传）
browser_execute_js({ code: <脚本>, timeout_ms: 60000 })
// 重复直到 200/200
```

---

## 翻页最佳实践

### 使用 browser_paginate（推荐，未来能力）

```
browser_paginate({
  target_page: 13,
  pager_root_selector: '[class*="content-ecom-pager"]',
  page_button_selector: '.content-ecom-pager-item',
  content_selector: '.content-ecom-Table-Row',
  pager_strategy: "visible_last",  // 处理双 pager
  max_steps: 20
})
```

### 手动翻页（当前可用）

```javascript
// 翻到指定页（逐页点击）
function gotoPage(target) {
  var current = getCurrentPage();
  while (current < target) {
    clickNextPage();
    await sleep(800);
    current = getCurrentPage();
  }
}
```

### 常见翻页陷阱

| 陷阱 | 表现 | 解决 |
|------|------|------|
| 双 pager | 点击了底部 pager，顶部没变 | 用 `pager_strategy: "visible_last"` |
| 省略号 | 目标页不在可见 pager 内 | 先点击省略号展开 |
| 表格未渲染 | pager 变了但表格还是老数据 | 等 `browser_wait(selector_text)` 确认 |
| 后期变慢 | 前 50 页 500ms/页，后 50 页 2s/页 | 动态适应当前页渲染速度 |

---

## CDN 直链获取策略

### 策略优先级

1. **API 拦截**（最优）→ 拦截 `BatchGetPlayVideoInfoTurtle` 等 API，从 JSON response 提取
2. **DOM 提取**（次优）→ `querySelectorAll('video[src*="oceanengine"]')`
3. **innerHTML 解析**（兜底）→ 从页面 HTML 源码中正则匹配

### API 拦截要点

```javascript
// hook 要在页面加载前安装
// 用 inject_preload_script 确保 document_start 执行
inject_preload_script({
  id: 'cdn_hook',
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
  `,
  run_at: "document_start",
  verify: true,
  reload: true
});
```

### 微前端注意事项

Garfish/qiankun 子应用可能缓存了 fetch/XHR 引用，晚注入 hook 无效。  
**解法**：`detect_microfrontends` → `inject_preload_script` at `document_start`。

如果 MAIN world preload 不可用，接受 degraded 结果（CDN 覆盖率 ~80%），用 DOM 提取补足。

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
| browser_execute_js 超时 | 数据在 localStorage，执行 progress 检查 |
| transport 断开 | `check_browser_health` 自动重连 |
| 页面筛选条件丢失 | 只能手动重设（没有程序化方式恢复） |
| 翻到一半浏览器关闭 | 重开页面，脚本从断点续传 |
| CDN 某页缺失 | 执行 CDN 回填脚本（只扫缺失页） |
| 数据有非目标品牌 | 筛选条件被污染，清理后重采 |

---

## 性能参考

| 操作 | 耗时 | 说明 |
|------|------|------|
| 翻 1 页 + 采集 5 行 | 550-700ms | SPA 翻页，正常情况 |
| 翻 1 页（后期变慢） | 2-5s | 页面/后端响应慢 |
| 200 页全部采集 | 3-5 分钟 | 含翻页 + 采集 + localStorage 写入 |
| CDN API 拦截安装 | 即时 | 不需要额外时间 |
| Blob 下载导出 | < 1s | 1000 条约 1MB |
