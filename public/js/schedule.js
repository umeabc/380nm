/* 380nm · 批量编排排期算法（纯函数） */
'use strict';
(function () {
  /**
   * 批量编排排期算法
   * 
   * 核心原则：
   * 1. 连续整点 = 1小时间隔 = 最均匀分布（不需要等距采样）
   * 2. 优先严格避让（在非避让点中找连续段）
   * 3. 无法严格避让时，选择覆盖避让点最少的连续窗口，平局取最早
   * 
   * @param {Object} cfg
   * @param {number} cfg.N - 有效链接数（需要排期的条目数）
   * @param {string} cfg.date - 日期 YYYY-MM-DD
   * @param {string} cfg.start - 时间窗起点 HH:MM（整点）
   * @param {string} cfg.end - 时间窗终点 HH:MM（整点）
   * @param {number[]} cfg.avoid - 避让整点数组 [11, 13, 17, 19]
   * @param {string} cfg.prefix - 标题前缀
   * @returns {{slots: Array, relaxed: boolean, conflicts: string[]}}
   */
  function plan(cfg) {
    const { N, date, start, end, avoid = [], prefix } = cfg;

    // 输入校验
    if (!N || N < 1) {
      throw new Error('请先录入作品链接');
    }
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('日期格式不正确');
    }
    if (!start || !/^\d{2}:\d{2}$/.test(start)) {
      throw new Error('开始时间格式不正确');
    }
    if (!end || !/^\d{2}:\d{2}$/.test(end)) {
      throw new Error('结束时间格式不正确');
    }

    // 解析日期与时间窗
    const [year, month, day] = date.split('-').map(Number);
    const startHour = parseInt(start.split(':')[0], 10);
    const endHour = parseInt(end.split(':')[0], 10);

    if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
      throw new Error('时间超出有效范围（0-23）');
    }
    if (endHour < startHour) {
      throw new Error('结束时间必须晚于开始时间');
    }

    // 计算时间窗整点数（含两端）
    const M = endHour - startHour + 1;
    if (N > M) {
      throw new Error(`时间窗仅 ${M} 个整点，少于 ${N} 条，请扩大时间窗或分批编排`);
    }

    // 生成时间窗内所有整点
    const window = [];
    for (let h = startHour; h <= endHour; h++) {
      window.push(h);
    }

    // 尝试严格避让：在非避让点中查找连续段
    const avoidSet = new Set(avoid);
    const available = window.filter(h => !avoidSet.has(h));

    // 查找连续段
    function findConsecutiveSegments(arr, minLen) {
      const segments = [];
      let current = [];
      for (let i = 0; i < arr.length; i++) {
        if (current.length === 0 || arr[i] === current[current.length - 1] + 1) {
          current.push(arr[i]);
        } else {
          if (current.length >= minLen) segments.push([...current]);
          current = [arr[i]];
        }
      }
      if (current.length >= minLen) segments.push(current);
      return segments;
    }

    const segments = findConsecutiveSegments(available, N);
    let selectedHours = [];
    let relaxed = false;
    let conflicts = [];

    if (segments.length > 0) {
      // 严格避让成功：取最早的段的前N个
      selectedHours = segments[0].slice(0, N);
      relaxed = false;
      conflicts = [];
    } else {
      // 放宽避让：枚举所有长度为N的连续窗口，选择命中避让点最少的
      relaxed = true;
      let bestWindow = null;
      let minConflicts = Infinity;

      for (let i = 0; i <= window.length - N; i++) {
        const candidate = window.slice(i, i + N);
        const conflictCount = candidate.filter(h => avoidSet.has(h)).length;
        
        // 只在命中数严格少于当前最佳时替换（平局保留最早）
        if (conflictCount < minConflicts) {
          minConflicts = conflictCount;
          bestWindow = candidate;
        }
      }

      selectedHours = bestWindow || [];
      conflicts = selectedHours.filter(h => avoidSet.has(h)).map(h => {
        const hh = String(h).padStart(2, '0');
        return `${hh}:00`;
      });
    }

    // 生成 slots：对每个整点构造本地时间 -> UTC ISO + 标题
    const slots = selectedHours.map((hour) => {
      // 构造本地时间（注意：月份从0开始）
      const localDate = new Date(year, month - 1, day, hour, 0, 0, 0);
      
      // 验证构造结果（防止夏令时等异常）
      if (localDate.getFullYear() !== year || 
          localDate.getMonth() !== month - 1 || 
          localDate.getDate() !== day ||
          localDate.getHours() !== hour) {
        throw new Error(`本地时间 ${date} ${hour}:00 不存在或无效`);
      }

      const scheduledAt = localDate.toISOString();
      const mm = String(month).padStart(2, '0');
      const dd = String(day).padStart(2, '0');
      const hh = String(hour).padStart(2, '0');
      const title = `「${prefix} ${mm}-${dd} ${hh}:00」`;

      // 标题长度校验
      if (title.length > 20) {
        throw new Error(`标题「${title}」超过20字，请缩短前缀`);
      }

      return {
        hour,
        time: `${hh}:00`,
        scheduledAt,
        title
      };
    });

    return { slots, relaxed, conflicts };
  }

  // 暴露到全局
  window.BatchSchedule = { plan };
})();
