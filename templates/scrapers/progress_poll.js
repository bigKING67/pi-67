/**
 * 通用进度轮询模板 v1.0
 * 
 * 用于 browser_execute_js 快速查看采集进度，不污染业务脚本的逻辑。
 * 
 * 用法：
 *   方案 A — 指定 storageKey 直接读取 localStorage：
 *     // 粘贴本模板并设置:
 *     CONFIG.storageKey = '_paginated_scrape';
 * 
 *   方案 B — 自定义检测逻辑：
 *     // 覆写 PROBE_FN:
 *     PROBE_FN = function() { return { pages: 42, records: 210 }; }
 * 
 * 返回格式：
 *   {
 *     status: "running" | "done" | "idle",
 *     pages: "42/200",
 *     records: 210,
 *     coverage: "85.0%",
 *     last_updated_ms_ago: 3200,
 *     pager_display: "1,2,3"
 *   }
 */

(function() {
  'use strict';

  // ============ 配置 ============
  var CONFIG = {
    storageKey: '_paginated_scrape',  // localStorage 键名
    cdnStorageKey: null,              // CDN 映射键名（如 _cdn_fv2），可选
    totalPages: 200,
    cdnField: 'CDN直链',
    reportToConsole: true,            // 输出到 console.log
  };

  // ============ 自定义检测（可选覆写） ============
  // 如果你的存储格式不同，直接覆写这个函数
  var PROBE_FN = null;

  // ============ 内部 ============
  function raw(key) {
    try { return localStorage[key]; } catch(e) { return null; }
  }

  function loadJSON(key) {
    var r = raw(key);
    return r ? JSON.parse(r) : null;
  }

  function buildReport() {
    // 自定义检测
    if (PROBE_FN) {
      return PROBE_FN();
    }

    // 默认：从 localStorage 读分页采集进度
    var meta = loadJSON(CONFIG.storageKey);
    var isDone = raw(CONFIG.storageKey + '_done') === '1';

    var records = (meta && meta.data) ? meta.data : [];
    var pages = (meta && meta.pages != null) ? meta.pages : 
                (parseInt(raw(CONFIG.storageKey + '_pages')) || 0);
    var recordCount = records.length || 
                      (parseInt(raw(CONFIG.storageKey + '_records')) || 0);

    // CDN 覆盖率
    var cdns = {};
    var cdnCount = 0;
    if (CONFIG.cdnStorageKey) {
      var cdnStore = loadJSON(CONFIG.cdnStorageKey);
      if (cdnStore && cdnStore.cdns) cdns = cdnStore.cdns;
      cdnCount = Object.keys(cdns).length;
    } else {
      cdnCount = records.filter(function(r) { return r[CONFIG.cdnField] && r[CONFIG.cdnField].length > 10; }).length;
    }

    var coverage = recordCount > 0 ? (cdnCount / recordCount * 100).toFixed(1) : '0';

    // 上次更新
    var updated = (meta && meta.updated) || 0;
    var msAgo = updated ? Date.now() - updated : -1;

    // 当前页面 pager 显示
    var checked = [];
    try {
      var items = document.querySelectorAll('.content-ecom-pager-item-checked');
      items.forEach(function(el) {
        var t = el.textContent.trim();
        if (t) checked.push(t);
      });
    } catch(e) {}

    return {
      status: isDone ? 'done' : (pages > 0 ? 'running' : 'idle'),
      pages: pages + '/' + CONFIG.totalPages,
      records: recordCount,
      cdn_coverage: coverage + '% (' + cdnCount + '/' + recordCount + ')',
      pager_display: checked.join(', ') || 'N/A',
      last_updated_ms_ago: msAgo,
      last_updated: updated ? new Date(updated).toISOString() : 'never',
      estimate_remaining: isDone ? 'N/A' : 
        (pages > 0 ? Math.ceil((CONFIG.totalPages - pages) * 0.7) + 's' : 'unknown'),
    };
  }

  // ============ 执行 ============
  var report = buildReport();

  if (CONFIG.reportToConsole) {
    console.log('=== PROGRESS ===');
    console.log('Status:    ' + report.status);
    console.log('Pages:     ' + report.pages);
    console.log('Records:   ' + report.records);
    console.log('CDN:       ' + report.cdn_coverage);
    console.log('Pager:     ' + report.pager_display);
    console.log('Remaining: ' + report.estimate_remaining);
    console.log('Updated:   ' + (report.last_updated_ms_ago >= 0 ? (report.last_updated_ms_ago / 1000).toFixed(1) + 's ago' : 'never'));
  }

  return report;

})();
