/**
 * 通用分页表格采集模板 v1.0
 * 
 * 用于浏览器端（browser_execute_js / browser_background_task）的批量分页数据采集。
 * 封装翻页循环、DOM 提取、localStorage 断点续传、进度追踪。
 * 
 * 业务方只需提供：
 *   1. config — selector 和存储配置
 *   2. extractRow(row, index, page) — 从单行提取数据的函数
 * 
 * 用法：
 *   // 在 browser_execute_js 中执行：
 *   // 定义 extractRow 函数
 *   function myExtract(row, i, page) { return { name: row.textContent }; }
 *   // 把本模板和 config 一起粘贴到 browser_execute_js
 * 
 * 依赖：浏览器 DOM API, localStorage, setTimeout
 * 适用：SPA 分页列表（URL 不变，翻页不刷新）
 */

(function() {
  'use strict';

  // ============ 配置项（业务方覆写） ============
  var CONFIG = {
    // === 必需 ===
    storageKey: '_paginated_scrape',  // localStorage 键名
    rowSelector: '.content-ecom-Table-Row',  // 数据行选择器（含表头）
    pagerSelector: '.content-ecom-pager-item',  // 分页按钮选择器
    pagerCheckedClass: 'content-ecom-pager-item-checked',  // 选中页样式
    totalPages: 200,                  // 总页数
    rowsPerPage: 5,                   // 每页数据行数
    waitAfterClick: 800,             // 翻页后等待 DOM 渲染 (ms)

    // === 可选 ===
    headerRowIndex: 0,               // 表头在第几行（0-based），用于跳过
    pagerDisabledClass: 'content-ecom-pager-item-disabled',
    waitForSelector: null,           // 等待此 selector 出现后再采集（如 '.data-loaded'）
    waitForSelectorTimeout: 5000,    // 等待超时 (ms)
    maxRetryPerPage: 2,             // 每页重试次数
    dateLabel: '',                   // 日期标签（写入每条记录）
    extraFields: {},                 // 额外固定字段（如 { 行业: '个护清洁' }）
  };

  // ============ 内部 ============
  var DATA = [];       // 已采集数据
  var SEEN = {};       // 去重键 → true
  var CP = 0;          // 当前已完成页数
  var RETRY = 0;       // 当前页重试计数

  function load() {
    try {
      var raw = localStorage[CONFIG.storageKey];
      var saved = raw ? JSON.parse(raw) : { data: [], pages: 0 };
      DATA = saved.data || [];
      CP = saved.pages || 0;
      DATA.forEach(function(r) {
        SEEN[String(r._dedupKey || r['排名'] || r._rank || '')] = true;
      });
    } catch(e) { DATA = []; CP = 0; }
  }

  function save() {
    localStorage[CONFIG.storageKey] = JSON.stringify({ data: DATA, pages: CP, updated: Date.now() });
    // 兼容进度检测
    localStorage[CONFIG.storageKey + '_pages'] = CP;
    localStorage[CONFIG.storageKey + '_records'] = DATA.length;
  }

  function getCurrentPage() {
    var items = document.querySelectorAll(CONFIG.pagerSelector);
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains(CONFIG.pagerCheckedClass)) {
        var txt = items[i].textContent.trim();
        return parseInt(txt) || 0;
      }
    }
    return 0;
  }

  function clickNextPage() {
    var items = document.querySelectorAll(CONFIG.pagerSelector);
    for (var i = 0; i < items.length; i++) {
      if (items[i].classList.contains(CONFIG.pagerCheckedClass)) {
        // 找下一个有效按钮
        for (var j = i + 1; j < items.length; j++) {
          var txt = items[j].textContent.trim();
          if (txt && !items[j].classList.contains(CONFIG.pagerDisabledClass)) {
            items[j].click();
            return true;
          }
        }
        return false;
      }
    }
    return false;
  }

  function getRows() {
    var all = document.querySelectorAll(CONFIG.rowSelector);
    var result = [];
    for (var i = 0; i < all.length; i++) {
      if (i === CONFIG.headerRowIndex) continue;
      result.push(all[i]);
    }
    return result;
  }

  // ============ 核心循环 ============
  function tick() {
    // 可选：等待特定 selector
    if (CONFIG.waitForSelector) {
      var waited = 0;
      var check = function() {
        if (document.querySelector(CONFIG.waitForSelector)) {
          doScrape();
        } else if (waited < CONFIG.waitForSelectorTimeout) {
          waited += 200;
          setTimeout(check, 200);
        } else {
          doScrape(); // 超时也执行，记录空结果
        }
      };
      check();
    } else {
      doScrape();
    }
  }

  function doScrape() {
    var rows = getRows();
    if (rows.length === 0) {
      RETRY++;
      if (RETRY <= CONFIG.maxRetryPerPage) {
        setTimeout(tick, CONFIG.waitAfterClick);
      } else {
        // 跳过空页
        CP++;
        RETRY = 0;
        save();
        next();
      }
      return;
    }

    RETRY = 0;
    var newRows = 0;

    for (var i = 0; i < rows.length; i++) {
      // ===== 业务方自定义的提取逻辑 =====
      var record = EXTRACT_FN(rows[i], i, CP);
      // =================================
      
      if (!record) continue;
      
      var dedupKey = String(record._dedupKey || record['排名'] || record._rank || '');
      if (dedupKey && SEEN[dedupKey]) continue;
      
      // 添加元信息
      if (CONFIG.dateLabel) record['日期'] = CONFIG.dateLabel;
      if (CONFIG.extraFields) {
        for (var k in CONFIG.extraFields) {
          if (!record[k]) record[k] = CONFIG.extraFields[k];
        }
      }

      SEEN[dedupKey] = true;
      DATA.push(record);
      newRows++;
    }

    CP++;
    save();

    next();
  }

  function next() {
    if (CP >= CONFIG.totalPages) {
      // ===== 完成 =====
      save();
      localStorage[CONFIG.storageKey + '_done'] = '1';
      console.log('[PAGINATED_SCRAPE] DONE: ' + DATA.length + ' records, ' + CP + ' pages');
      return;
    }

    if (!clickNextPage()) {
      // 可能已到最后一页
      CP = CONFIG.totalPages;
      save();
      localStorage[CONFIG.storageKey + '_done'] = '1';
      console.log('[PAGINATED_SCRAPE] DONE (no more pages): ' + DATA.length + ' records');
      return;
    }

    setTimeout(tick, CONFIG.waitAfterClick);
  }

  // ============ 启动 ============
  load();
  localStorage[CONFIG.storageKey + '_done'] = '0';
  console.log('[PAGINATED_SCRAPE] Starting from ' + DATA.length + ' records, ' + CP + '/' + CONFIG.totalPages + ' pages');

  if (CP >= CONFIG.totalPages) {
    console.log('[PAGINATED_SCRAPE] Already complete. Run merge_export to generate output.');
    return;
  }

  // 如果当前不在第 1 + CP 页，需要先翻到
  // （简化处理：假设会话开始时已在正确位置）
  setTimeout(tick, 500);

})();
