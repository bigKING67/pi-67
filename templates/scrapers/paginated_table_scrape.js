/**
 * 通用分页表格采集模板 v1.1
 * 
 * 用于浏览器端（browser_execute_js / browser_job_ops）的批量分页数据采集。
 * 封装翻页循环、DOM 提取、localStorage 断点续传、进度追踪。
 * 
 * 业务方只需提供：
 *   1. config — selector 和存储配置
 *   2. extractRow(row, index, page) — 从单行提取数据的函数
 * 
 * 用法：
 *   // 在 browser_execute_js 的 script 参数中执行，或作为 browser_job_ops start.script：
 *   // 定义 extractRow 函数
 *   function myExtract(row, i, page) { return { name: row.textContent }; }
 *   // 把本模板和 config 一起传给工具；顶层 Promise 会在单批完成或失败时结束
 * 
 * 依赖：浏览器 DOM API, localStorage, Promise, setTimeout
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
    nextPageSelector: null,          // 目标页按钮被省略时使用的 next 控件 selector
    waitForSelector: null,           // 等待此 selector 出现后再采集（如 '.data-loaded'）
    waitForSelectorTimeout: 5000,    // 等待超时 (ms)
    pageChangeTimeout: 10000,        // 点击后等待页码/首行签名变化
    pollInterval: 100,               // 页面状态轮询间隔
    maxPagesPerRun: 10,              // 单个工具调用最多采集页数，避免撞到 120s 上限
    maxRetryPerPage: 2,             // 每页重试次数
    dateLabel: '',                   // 日期标签（写入每条记录）
    extraFields: {},                 // 额外固定字段（如 { 行业: '个护清洁' }）
  };

  // ============ 内部 ============
  var DATA = [];       // 已采集数据
  var SEEN = {};       // 去重键 → true
  var CP = 0;          // 当前已完成页数
  var RETRY = 0;       // 当前页重试计数
  var START_CP = 0;    // 本批启动时已完成页数
  var LOAD_ERROR = null;
  var FINISHED = false;
  var RESOLVE_RUN = null;

  function load() {
    try {
      var raw = localStorage[CONFIG.storageKey];
      var saved = raw ? JSON.parse(raw) : { data: [], pages: 0 };
      if (!saved || typeof saved !== 'object' || !Array.isArray(saved.data)) {
        throw new Error('checkpoint.data must be an array');
      }
      if (!Number.isInteger(saved.pages) || saved.pages < 0 || saved.pages > CONFIG.totalPages) {
        throw new Error('checkpoint.pages is outside the valid range');
      }
      DATA = saved.data;
      CP = saved.pages;
      DATA.forEach(function(r) {
        SEEN[String(r._dedupKey || r['排名'] || r._rank || '')] = true;
      });
    } catch(e) {
      DATA = [];
      CP = 0;
      LOAD_ERROR = String(e && e.message ? e.message : e);
    }
  }

  function save() {
    localStorage[CONFIG.storageKey] = JSON.stringify({ data: DATA, pages: CP, updated: Date.now() });
    // 兼容进度检测
    localStorage[CONFIG.storageKey + '_pages'] = CP;
    localStorage[CONFIG.storageKey + '_records'] = DATA.length;
  }

  function finish(status, detail) {
    if (FINISHED) return;
    FINISHED = true;
    var result = {
      status: status,
      pages_completed: CP,
      pages_this_run: CP - START_CP,
      records: DATA.length,
      storage_key: CONFIG.storageKey,
    };
    if (detail) {
      for (var key in detail) result[key] = detail[key];
    }
    if (RESOLVE_RUN) RESOLVE_RUN(result);
  }

  function isVisible(element) {
    if (!element) return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getCurrentPage() {
    var items = document.querySelectorAll(CONFIG.pagerSelector);
    for (var i = items.length - 1; i >= 0; i--) {
      if (items[i].classList.contains(CONFIG.pagerCheckedClass)) {
        var txt = items[i].textContent.trim();
        if (isVisible(items[i])) return parseInt(txt) || 0;
      }
    }
    return 0;
  }

  function clickNextPage() {
    var items = document.querySelectorAll(CONFIG.pagerSelector);
    var target = getCurrentPage() + 1;
    for (var i = items.length - 1; i >= 0; i--) {
      var txt = items[i].textContent.trim();
      if (isVisible(items[i]) && txt === String(target) &&
          !items[i].classList.contains(CONFIG.pagerDisabledClass)) {
        items[i].click();
        return true;
      }
    }

    if (CONFIG.nextPageSelector) {
      var nextItems = document.querySelectorAll(CONFIG.nextPageSelector);
      for (var j = nextItems.length - 1; j >= 0; j--) {
        if (isVisible(nextItems[j]) && !nextItems[j].classList.contains(CONFIG.pagerDisabledClass)) {
          nextItems[j].click();
          return true;
        }
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

  function firstRowSignature() {
    var rows = getRows();
    return rows.length ? rows[0].textContent.trim().substring(0, 500) : '';
  }

  function waitForNextPage(previousPage, previousSignature, callback) {
    var started = Date.now();
    var check = function() {
      var currentPage = getCurrentPage();
      var currentSignature = firstRowSignature();
      var pageChanged = previousPage > 0 && currentPage > 0 && currentPage !== previousPage;
      var contentChanged = previousSignature && currentSignature && currentSignature !== previousSignature;
      if ((pageChanged || contentChanged) && getRows().length > 0) {
        callback(true);
      } else if (Date.now() - started >= CONFIG.pageChangeTimeout) {
        callback(false);
      } else {
        setTimeout(check, CONFIG.pollInterval);
      }
    };
    setTimeout(check, CONFIG.pollInterval);
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
          finish('failed', { error: 'wait_for_selector_timeout', selector: CONFIG.waitForSelector });
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
        finish('failed', { error: 'empty_page_after_retries', page: getCurrentPage() || (CP + 1) });
      }
      return;
    }

    RETRY = 0;
    var dataLengthBeforePage = DATA.length;
    var newRows = 0;

    for (var i = 0; i < rows.length; i++) {
      // ===== 业务方自定义的提取逻辑 =====
      var record;
      try {
        record = EXTRACT_FN(rows[i], i, getCurrentPage() || (CP + 1));
      } catch (e) {
        DATA.length = dataLengthBeforePage;
        finish('failed', {
          error: 'extract_row_failed',
          row_index: i,
          detail: String(e && e.message ? e.message : e),
        });
        return;
      }
      // =================================
      
      if (!record) continue;
      
      var dedupKey = String(record._dedupKey || record['排名'] || record._rank || '');
      if (dedupKey && SEEN[dedupKey]) continue;
      
      // 添加元信息
      if (CONFIG.dateLabel) record['日期'] = CONFIG.dateLabel;
      if (CONFIG.extraFields) {
        for (var k in CONFIG.extraFields) {
          if (record[k] === undefined || record[k] === null) record[k] = CONFIG.extraFields[k];
        }
      }

      SEEN[dedupKey] = true;
      DATA.push(record);
      newRows++;
    }

    CP++;
    try {
      save();
    } catch (e) {
      CP--;
      DATA.length = dataLengthBeforePage;
      finish('failed', {
        error: 'checkpoint_write_failed',
        detail: String(e && e.message ? e.message : e),
      });
      return;
    }

    next();
  }

  function next() {
    if (CP >= CONFIG.totalPages) {
      // ===== 完成 =====
      try {
        localStorage[CONFIG.storageKey + '_done'] = '1';
      } catch (e) {
        finish('failed', {
          error: 'completion_marker_write_failed',
          detail: String(e && e.message ? e.message : e),
        });
        return;
      }
      console.log('[PAGINATED_SCRAPE] DONE: ' + DATA.length + ' records, ' + CP + ' pages');
      finish('done');
      return;
    }

    if (CP - START_CP >= CONFIG.maxPagesPerRun) {
      console.log('[PAGINATED_SCRAPE] BATCH COMPLETE: ' + (CP - START_CP) + ' pages');
      finish('batch_complete', { resume_required: true });
      return;
    }

    var previousPage = getCurrentPage();
    var previousSignature = firstRowSignature();
    if (!clickNextPage()) {
      finish('failed', { error: 'next_page_not_found', page: previousPage || CP });
      return;
    }

    waitForNextPage(previousPage, previousSignature, function(changed) {
      if (!changed) {
        finish('failed', { error: 'page_change_timeout', page: previousPage || CP });
        return;
      }
      setTimeout(tick, CONFIG.waitAfterClick);
    });
  }

  // ============ 启动 ============
  load();
  START_CP = CP;
  console.log('[PAGINATED_SCRAPE] Starting from ' + DATA.length + ' records, ' + CP + '/' + CONFIG.totalPages + ' pages');

  if (CP >= CONFIG.totalPages) {
    console.log('[PAGINATED_SCRAPE] Already complete. Run merge_export to generate output.');
    return { status: 'done', pages_completed: CP, pages_this_run: 0, records: DATA.length, storage_key: CONFIG.storageKey };
  }

  if (LOAD_ERROR) {
    console.error('[PAGINATED_SCRAPE] Refusing to overwrite invalid checkpoint: ' + LOAD_ERROR);
    return { status: 'failed', error: 'invalid_checkpoint', detail: LOAD_ERROR, storage_key: CONFIG.storageKey };
  }

  // 调用方必须先把页面定位到 CP + 1；模板不猜测或静默跳转断点位置。
  var currentPage = getCurrentPage();
  if (currentPage > 0 && currentPage !== CP + 1) {
    return {
      status: 'failed',
      error: 'checkpoint_page_mismatch',
      expected_page: CP + 1,
      current_page: currentPage,
      storage_key: CONFIG.storageKey,
    };
  }

  try {
    localStorage[CONFIG.storageKey + '_done'] = '0';
  } catch (e) {
    return {
      status: 'failed',
      error: 'progress_marker_write_failed',
      detail: String(e && e.message ? e.message : e),
      storage_key: CONFIG.storageKey,
    };
  }

  return new Promise(function(resolve) {
    RESOLVE_RUN = resolve;
    setTimeout(tick, 0);
  });
})();
