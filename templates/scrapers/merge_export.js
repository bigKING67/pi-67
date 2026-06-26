/**
 * 通用合稿导出模板 v1.0
 * 
 * 从 localStorage 读取元数据和 CDN 映射，合并、去重、排序、字段重排，
 * 然后触发浏览器 Blob 下载。
 * 
 * 业务方配置：
 *   1. CONFIG — 存储键、字段映射、日期等
 * 
 * 用法：
 *   // 粘贴本模板 + 覆写 CONFIG 后执行
 * 
 * 输出：浏览器自动下载 JSON 文件
 */

(function() {
  'use strict';

  // ============ 配置（业务方覆写） ============
  var CONFIG = {
    // === 数据源 ===
    metaStorageKey: '_paginated_scrape',      // 元数据 localStorage 键
    metaDataField: 'data',                     // 元数据中数据数组的字段名
    cdnStorageKey: null,                       // CDN 映射键（null 表示无 CDN）
    cdnDataField: 'cdns',                      // CDN 映射中数据的字段名
    cdnMatchField: '排名',                     // 用哪个字段匹配 CDN（作为 cdnMap 的 key）

    // === 导出 ===
    dateLabel: '2026-05',                     // 日期字段值
    fileName: 'export.json',                   // 下载文件名
    sortField: '排名',                         // 排序字段
    sortNumeric: true,                         // 是否数字排序

    // === 字段 ===
    fieldOrder: [                              // 字段顺序（按此顺序排列）
      '日期', '排名', '视频内容', '核心人群'
    ],
    dedupFields: ['排名'],                     // 去重依据字段（组合键）

    // === 行为 ===
    fillEmpty: true,                           // 缺失字段填空字符串
    validateFieldOrder: false,                 // 是否强制丢弃不在 fieldOrder 中的字段
    maxRecords: null,                          // 最大记录数限制
  };

  // ============ 内部 ============
  function loadJSON(key) {
    try { 
      var raw = localStorage[key]; 
      return raw ? JSON.parse(raw) : null; 
    } catch(e) { return null; }
  }

  // ============ 1. 读取元数据 ============
  var metaStore = loadJSON(CONFIG.metaStorageKey);
  if (!metaStore) {
    console.error('[MERGE] No data at ' + CONFIG.metaStorageKey);
    return { error: 'no_meta_data' };
  }

  var records = CONFIG.metaDataField ? (metaStore[CONFIG.metaDataField] || []) : metaStore;
  if (!Array.isArray(records)) records = [];
  if (records.length === 0) {
    console.error('[MERGE] Empty data');
    return { error: 'empty_data' };
  }

  // ============ 2. 读取 CDN 映射 ============
  var cdnMap = {};
  if (CONFIG.cdnStorageKey) {
    var cdnStore = loadJSON(CONFIG.cdnStorageKey);
    if (cdnStore) {
      cdnMap = CONFIG.cdnDataField ? (cdnStore[CONFIG.cdnDataField] || {}) : cdnStore;
    }
  }

  // ============ 3. 合并 CDN ============
  var filled = 0;
  if (Object.keys(cdnMap).length > 0) {
    records.forEach(function(r) {
      var key = String(r[CONFIG.cdnMatchField] || '');
      if ((!r['CDN直链'] || r['CDN直链'].length < 10) && cdnMap[key]) {
        r['CDN直链'] = cdnMap[key];
        filled++;
      }
    });
  }

  // ============ 4. 添加日期 + 字段重排 ============
  var ordered = records.map(function(r) {
    var out = { '日期': CONFIG.dateLabel };
    CONFIG.fieldOrder.forEach(function(k) {
      if (k === '日期') return;
      out[k] = (r[k] !== undefined && r[k] !== null) ? r[k] : (CONFIG.fillEmpty ? '' : undefined);
    });
    // 保留不在 fieldOrder 中的字段
    if (!CONFIG.validateFieldOrder) {
      for (var key in r) {
        if (!(key in out)) out[key] = r[key];
      }
    }
    return out;
  });

  // ============ 5. 排序 ============
  var sortField = CONFIG.sortField;
  if (CONFIG.sortNumeric) {
    ordered.sort(function(a, b) {
      return (parseInt(a[sortField]) || 999999) - (parseInt(b[sortField]) || 999999);
    });
  } else {
    ordered.sort(function(a, b) {
      return String(a[sortField] || '').localeCompare(String(b[sortField] || ''));
    });
  }

  // ============ 6. 去重 ============
  var seen = {};
  var deduped = [];
  ordered.forEach(function(r) {
    var key = CONFIG.dedupFields.map(function(f) { 
      return String(r[f] || '').substring(0, 60); 
    }).join('|');
    if (seen[key]) return;
    seen[key] = true;
    deduped.push(r);
  });

  // ============ 7. 截断 ============
  if (CONFIG.maxRecords && deduped.length > CONFIG.maxRecords) {
    deduped = deduped.slice(0, CONFIG.maxRecords);
  }

  // ============ 8. 统计 ============
  var withCDN = deduped.filter(function(r) { return r['CDN直链'] && r['CDN直链'].length > 10; }).length;
  var coverage = deduped.length > 0 ? (withCDN / deduped.length * 100).toFixed(1) : '0';

  var stats = {
    records: deduped.length,
    cdns: withCDN,
    coverage: coverage + '%',
    filled_from_map: filled,
    dedup_dropped: ordered.length - deduped.length,
  };

  console.log('=== MERGE EXPORT ===');
  console.log('Records:    ' + stats.records);
  console.log('CDN:        ' + stats.cdns + ' (' + stats.coverage + ')');
  console.log('Map filled: ' + stats.filled_from_map);
  console.log('Dropped:    ' + stats.dedup_dropped);

  // ============ 9. 导出 ============
  var exportJSON = JSON.stringify({ data: deduped, _stats: stats });
  localStorage._last_export = exportJSON;

  var blob = new Blob([exportJSON], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = CONFIG.fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  console.log('=== EXPORTED: ' + CONFIG.fileName + ' ===');

  return stats;

})();
