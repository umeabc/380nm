/* 380nm · 临近时间判定逻辑：集中所有阈值常量与时间分类。
 * UMD 双导出（浏览器 window.NearTime + Node module.exports）。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.NearTime = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // 阈值常量：单张页 10 分钟，批量页 30 分钟
  const RELEASE_NEAR_MS = 10 * 60 * 1000;
  const BATCH_NEAR_MS = 30 * 60 * 1000;

  /**
   * 对单个时间值分类：空、非法、过去、临近、未来。
   * @param {string} scheduledAt - 时间字符串（ISO 或任何 Date 构造器接受的格式）
   * @param {number} nowMs - 当前时间的 epoch（毫秒）
   * @param {number} thresholdMs - 临近阈值（毫秒）
   * @return {{ kind, atMs, deltaMs, needsConfirm }}
   *   - kind: 'empty' | 'invalid' | 'past' | 'near' | 'future'
   *   - atMs: 计划时间的 epoch（kind='empty'/'invalid' 时为 NaN）
   *   - deltaMs: atMs - nowMs（负数表示过去）
   *   - needsConfirm: 是否需要弹窗确认
   */
  function classifyTime(scheduledAt, nowMs, thresholdMs) {
    const trimmed = String(scheduledAt || '').trim();
    if (!trimmed) {
      return { kind: 'empty', atMs: NaN, deltaMs: NaN, needsConfirm: true };
    }
    const d = new Date(trimmed);
    const atMs = d.getTime();
    if (isNaN(atMs)) {
      return { kind: 'invalid', atMs: NaN, deltaMs: NaN, needsConfirm: false };
    }
    const deltaMs = atMs - nowMs;
    if (deltaMs < 0) {
      return { kind: 'past', atMs, deltaMs, needsConfirm: true };
    }
    if (deltaMs <= thresholdMs) {
      return { kind: 'near', atMs, deltaMs, needsConfirm: true };
    }
    return { kind: 'future', atMs, deltaMs, needsConfirm: false };
  }

  /**
   * 批量汇总：统计在阈值内（含过去）的合法时间项。
   * @param {string[]} isoTimes - 时间字符串数组
   * @param {number} nowMs - 当前时间的 epoch（毫秒）
   * @param {number} thresholdMs - 临近阈值（毫秒）
   * @return {{ count, earliestMs, invalidCount }}
   *   - count: 在阈值内的合法项数（含负）
   *   - earliestMs: 这些项中原计划时间的最小值（epoch）；无合法临近项时为 NaN
   *   - invalidCount: 非法时间的项数
   */
  function summarizeNearTimes(isoTimes, nowMs, thresholdMs) {
    let count = 0, earliestMs = Infinity, invalidCount = 0;
    for (const t of isoTimes) {
      const trimmed = String(t || '').trim();
      if (!trimmed) continue; // 空串跳过（不计入统计）
      const d = new Date(trimmed);
      const atMs = d.getTime();
      if (isNaN(atMs)) {
        invalidCount++;
        continue;
      }
      const deltaMs = atMs - nowMs;
      if (deltaMs <= thresholdMs) { // 含负
        count++;
        if (atMs < earliestMs) earliestMs = atMs;
      }
    }
    return { count, earliestMs: count > 0 ? earliestMs : NaN, invalidCount };
  }

  /**
   * 格式化 epoch 为本地时间字符串（YYYY-MM-DD HH:mm）。
   * @param {number} ms - epoch（毫秒）
   * @return {string} 可读时间串；非法输入返回空串
   */
  function formatLocalTime(ms) {
    if (typeof ms !== 'number' || isNaN(ms)) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  return {
    RELEASE_NEAR_MS,
    BATCH_NEAR_MS,
    classifyTime,
    summarizeNearTimes,
    formatLocalTime
  };
});
