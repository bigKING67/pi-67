/**
 * 通用 API 拦截 + 数据收集模板 v1.1
 * 
 * 在浏览器页面上安装 fetch / XHR 拦截器，捕获匹配 URL 模式的
 * API 请求/响应数据，存储到 localStorage 供后续合并使用。
 * 
 * 适用场景：
 *   - CDN 直链获取（拦截视频信息 API）
 *   - 签名参数抓取（拦截加密请求）
 *   - 任何需要在页面运行时捕获的异步数据
 * 
 * 用法：
 *   1. 设置 CONFIG.hooks（URL 匹配规则 + 数据提取函数）
 *   2. 通过 browser_execute_js 的 script 参数执行本模板
 *   3. 后续用 js_reverse_get_storage 或 browser_execute_js 定点读取 storageKey
 * 
 * 注意：
 *   - 本模板只 patch 当前 document 的 MAIN world，对子 frame 不自动生效
 *   - iframe/微前端先用 js_reverse_list_frames 建 frame tree；跨域 frame 只有 degraded metadata
 *   - 首屏场景使用 js_reverse_inject_preload_script 时必须检查 preload_semantics；它不保证 true document_start
 *   - hook 在页面刷新后失效，需重新注入
 */

(function() {
  'use strict';

  // ============ 配置 ============
  var CONFIG = {
    // === 存储 ===
    storageKey: '_network_hook_collect',   // localStorage 键名
    // === 拦截规则 ===
    hooks: [
      // 每条规则：{ type, urlPattern, extract(respOrBody) }
      // 示例：
      // {
      //   type: 'fetch_response',
      //   urlPattern: /BatchGetPlayVideoInfoTurtle/,
      //   extract: function(json) {
      //     var items = json.data || [];
      //     return items.map(function(item) {
      //       return { videoUrl: item.videoUrl, posterUrl: item.posterUrl };
      //     });
      //   }
      // }
    ],

    // === 行为 ===
    patchConsole: false,              // 是否输出 console 日志
    dedupById: null,                  // 去重键（如 'videoUrl'）
    maxStoredItems: 10000,            // 最大存储条数
  };

  // ============ 初始化存储 ============
  var COLLECTED = [];
  var ERRORS = [];
  var CHECKPOINT_VALID = true;

  function recordError(stage, error) {
    var row = {
      stage: stage,
      message: String(error && error.message ? error.message : error),
      at: new Date().toISOString(),
    };
    ERRORS.push(row);
    ERRORS = ERRORS.slice(-50);
    try {
      localStorage[CONFIG.storageKey + '_errors'] = JSON.stringify(ERRORS);
    } catch (_) {}
    if (CONFIG.patchConsole) console.error('[HOOK] ' + stage + ': ' + row.message);
  }

  function load() {
    try {
      var raw = localStorage[CONFIG.storageKey];
      if (raw) {
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw new Error('checkpoint must contain an array');
        COLLECTED = parsed;
      }
    } catch(e) {
      COLLECTED = [];
      CHECKPOINT_VALID = false;
      recordError('load_checkpoint', e);
    }
  }

  function save() {
    if (COLLECTED.length > CONFIG.maxStoredItems) {
      COLLECTED = COLLECTED.slice(-CONFIG.maxStoredItems);
    }
    localStorage[CONFIG.storageKey] = JSON.stringify(COLLECTED);
  }

  function addItems(items) {
    if (!items || !items.length) return;
    if (!CHECKPOINT_VALID) {
      recordError('checkpoint_unusable', 'Refusing to overwrite an invalid checkpoint');
      return;
    }
    
    if (CONFIG.dedupById) {
      var seen = {};
      COLLECTED.forEach(function(item) { seen[item[CONFIG.dedupById]] = true; });
      items = items.filter(function(item) {
        var key = item[CONFIG.dedupById];
        if (key == null || key === '') return true;
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
    }

    if (items.length > 0) {
      var previousLength = COLLECTED.length;
      COLLECTED = COLLECTED.concat(items);
      try {
        save();
      } catch (e) {
        COLLECTED.length = previousLength;
        recordError('save_checkpoint', e);
        return;
      }
      if (CONFIG.patchConsole) {
        console.log('[HOOK] +' + items.length + ' items, total: ' + COLLECTED.length);
      }
    }
  }

  function matches(pattern, value) {
    if (!(pattern instanceof RegExp)) return false;
    pattern.lastIndex = 0;
    return pattern.test(value);
  }

  load();

  // ============ fetch 拦截 ============
  var hasFetchHooks = CONFIG.hooks.some(function(h) { return h.type === 'fetch_response' || h.type === 'fetch_request'; });
  if (hasFetchHooks && !window.__nkHookFetchInstalled) {
    var origFetch = window.fetch;
    window.fetch = function(url, options) {
      var promise = origFetch.apply(this, arguments);
      var urlStr = typeof url === 'string' ? url : (url.url || '');

      CONFIG.hooks.forEach(function(hook) {
        if (hook.type === 'fetch_request' && matches(hook.urlPattern, urlStr)) {
          try {
            var items = hook.extract({ url: urlStr, options: options });
            addItems(items);
          } catch(e) { recordError('fetch_request_extract', e); }
        }

        if (hook.type === 'fetch_response' && matches(hook.urlPattern, urlStr)) {
          promise.then(function(resp) {
            return resp.clone().json();
          }).then(function(json) {
            try {
              var items = hook.extract(json, { url: urlStr });
              addItems(items);
            } catch(e) { recordError('fetch_response_extract', e); }
          }).catch(function(e) { recordError('fetch_response_read', e); });
        }
      });

      return promise;
    };
    window.__nkHookFetchInstalled = true;
  }

  // ============ XHR 拦截 ============
  var hasXHRHooks = CONFIG.hooks.some(function(h) { return h.type === 'xhr_response' || h.type === 'xhr_request'; });
  if (hasXHRHooks && !window.__nkHookXhrInstalled) {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
      this.__nkUrl = url;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function() {
      var self = this;
      var url = self.__nkUrl || '';
      var requestBody = arguments[0];

      CONFIG.hooks.forEach(function(hook) {
        if (hook.type === 'xhr_request' && matches(hook.urlPattern, url)) {
          try {
            var items = hook.extract({ url: url, body: requestBody });
            addItems(items);
          } catch(e) { recordError('xhr_request_extract', e); }
        }
      });

      self.addEventListener('load', function() {
        CONFIG.hooks.forEach(function(hook) {
          if (hook.type === 'xhr_response' && matches(hook.urlPattern, url)) {
            try {
              var body = self.responseText;
              var json = body ? JSON.parse(body) : {};
              var items = hook.extract(json, { url: url });
              addItems(items);
            } catch(e) { recordError('xhr_response_extract', e); }
          }
        });
      });

      return origSend.apply(this, arguments);
    };
    window.__nkHookXhrInstalled = true;
  }

  // ============ 执行 ============
  var activeHooks = CONFIG.hooks.map(function(h) { return h.type + ':' + h.urlPattern.toString().substring(0, 50); });

  console.log('[NETWORK_HOOK] Installed ' + activeHooks.length + ' hooks');
  console.log('[NETWORK_HOOK] Storage: ' + CONFIG.storageKey + ' (' + COLLECTED.length + ' items)');
  console.log('[NETWORK_HOOK] Patterns:');
  activeHooks.forEach(function(p) { console.log('  - ' + p); });

  return {
    hooks_installed: activeHooks.length,
    existing_items: COLLECTED.length,
    storage_key: CONFIG.storageKey,
    checkpoint_valid: CHECKPOINT_VALID,
    error_count: ERRORS.length,
    error_storage_key: CONFIG.storageKey + '_errors'
  };

})();
