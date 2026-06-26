/**
 * 通用 API 拦截 + 数据收集模板 v1.0
 * 
 * 在浏览器页面上安装 fetch / XHR / WebSocket 拦截器，捕获匹配 URL 模式的
 * API 请求/响应数据，存储到 localStorage 供后续合并使用。
 * 
 * 适用场景：
 *   - CDN 直链获取（拦截视频信息 API）
 *   - 签名参数抓取（拦截加密请求）
 *   - 任何需要在页面运行时捕获的异步数据
 * 
 * 用法：
 *   1. 设置 CONFIG.hooks（URL 匹配规则 + 数据提取函数）
 *   2. 在 browser_execute_js / browser_background_task 中执行
 *   3. 后续用 merge_export 或自定义脚本读取 localStorage 中的数据
 * 
 * 注意：
 *   - 本模板在 MAIN world 打 patch，对微前端子应用可能无效
 *   - 如需微前端支持，先执行 detect_microfrontends 确定注入策略
 *   - hook 在页面刷新后失效，需重新注入
 */

(function() {
  'use strict';

  // ============ 配置 ============
  var CONFIG = {
    // === 存储 ===
    storageKey: '_network_hook_collect',   // localStorage 键名
    storageFormat: 'array',                 // 'array' | 'map' (map 按 id/key 去重)

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

  function load() {
    try {
      var raw = localStorage[CONFIG.storageKey];
      if (raw) COLLECTED = JSON.parse(raw);
      if (!Array.isArray(COLLECTED)) COLLECTED = [];
    } catch(e) { COLLECTED = []; }
  }

  function save() {
    if (COLLECTED.length > CONFIG.maxStoredItems) {
      COLLECTED = COLLECTED.slice(-CONFIG.maxStoredItems);
    }
    localStorage[CONFIG.storageKey] = JSON.stringify(COLLECTED);
  }

  function addItems(items) {
    if (!items || !items.length) return;
    
    if (CONFIG.dedupById) {
      var seen = {};
      COLLECTED.forEach(function(item) { seen[item[CONFIG.dedupById]] = true; });
      items = items.filter(function(item) { return !seen[item[CONFIG.dedupById]]; });
    }

    if (items.length > 0) {
      COLLECTED = COLLECTED.concat(items);
      save();
      if (CONFIG.patchConsole) {
        console.log('[HOOK] +' + items.length + ' items, total: ' + COLLECTED.length);
      }
    }
  }

  // ============ fetch 拦截 ============
  var hasFetchHooks = CONFIG.hooks.some(function(h) { return h.type === 'fetch_response' || h.type === 'fetch_request'; });
  if (hasFetchHooks && !window.__nkHookFetchInstalled) {
    var origFetch = window.fetch;
    window.fetch = function(url, options) {
      var promise = origFetch.apply(this, arguments);
      var urlStr = typeof url === 'string' ? url : (url.url || '');

      CONFIG.hooks.forEach(function(hook) {
        if (hook.type === 'fetch_request' && hook.urlPattern.test(urlStr)) {
          try {
            var items = hook.extract({ url: urlStr, options: options });
            addItems(items);
          } catch(e) {}
        }

        if (hook.type === 'fetch_response' && hook.urlPattern.test(urlStr)) {
          promise.then(function(resp) {
            return resp.clone().json();
          }).then(function(json) {
            try {
              var items = hook.extract(json, { url: urlStr });
              addItems(items);
            } catch(e) {}
          }).catch(function() {});
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

      CONFIG.hooks.forEach(function(hook) {
        if (hook.type === 'xhr_request' && hook.urlPattern.test(url)) {
          try {
            var items = hook.extract({ url: url, body: arguments[0] });
            addItems(items);
          } catch(e) {}
        }
      });

      self.addEventListener('load', function() {
        CONFIG.hooks.forEach(function(hook) {
          if (hook.type === 'xhr_response' && hook.urlPattern.test(url)) {
            try {
              var body = self.responseText;
              var json = body ? JSON.parse(body) : {};
              var items = hook.extract(json, { url: url });
              addItems(items);
            } catch(e) {}
          }
        });
      });

      return origSend.apply(this, arguments);
    };
    window.__nkHookXhrInstalled = true;
  }

  // ============ 执行 ============
  load();

  var activeHooks = CONFIG.hooks.map(function(h) { return h.type + ':' + h.urlPattern.toString().substring(0, 50); });

  console.log('[NETWORK_HOOK] Installed ' + activeHooks.length + ' hooks');
  console.log('[NETWORK_HOOK] Storage: ' + CONFIG.storageKey + ' (' + COLLECTED.length + ' items)');
  console.log('[NETWORK_HOOK] Patterns:');
  activeHooks.forEach(function(p) { console.log('  - ' + p); });

  return {
    hooks_installed: activeHooks.length,
    existing_items: COLLECTED.length,
    storage_key: CONFIG.storageKey
  };

})();
