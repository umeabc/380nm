/* 380nm · 批量编排排期算法（本地时区，纯函数） */
'use strict';
(function () {
  function candidates(cfg) {
    const { date, start, end, after } = cfg;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('日期格式不正确');
    const parts = date.split('-').map(Number);
    const day = new Date(parts[0], parts[1] - 1, parts[2]);
    if (day.getFullYear() !== parts[0] || day.getMonth() !== parts[1] - 1 || day.getDate() !== parts[2]) throw new Error('日期不存在');
    const minutes = value => {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')) throw new Error('时间格式不正确');
      const [h, m] = value.split(':').map(Number); return h * 60 + m;
    };
    const from = minutes(start), to = minutes(end);
    if (to < from) throw new Error('结束时间必须晚于开始时间');
    const mode = cfg.scheduleMode || 'interval';
    const interval = cfg.intervalMinutes === undefined ? 60 : Number(cfg.intervalMinutes);
    const tail = Number(cfg.minuteTail);
    if (!['interval', 'minute-tail'].includes(mode)) throw new Error('排期模式无效');
    if (mode === 'interval' && (!Number.isSafeInteger(interval) || interval < 1)) throw new Error('间隔必须为正整数分钟');
    if (mode === 'minute-tail' && (!Number.isInteger(tail) || tail < 0 || tail > 9)) throw new Error('分钟尾数必须是 0～9');
    const slots = [];
    for (let minute = from; minute <= to; minute++) {
      if (mode === 'interval' ? (minute - from) % interval !== 0 : minute % 10 !== tail) continue;
      const hour = Math.floor(minute / 60), mi = minute % 60;
      const local = new Date(parts[0], parts[1] - 1, parts[2], hour, mi);
      if (local.getHours() !== hour || local.getMinutes() !== mi) throw new Error('本地时间不存在');
      if (typeof after === 'number' && local.getTime() <= after) continue;
      const time = String(hour).padStart(2, '0') + ':' + String(mi).padStart(2, '0');
      slots.push({ hour, minute: mi, time, scheduledAt: local.toISOString(), title: '「' + date.slice(5) + ' ' + time + '」' });
    }
    return slots;
  }
  function plan(cfg) {
    if (!Number.isInteger(cfg.N) || cfg.N < 1) throw new Error('请先录入作品链接');
    const slots = candidates(cfg), N = cfg.N;
    if (N > slots.length) throw new Error('时间窗' + (cfg.after !== undefined ? '过滤后' : '') + '仅 ' + slots.length + ' 个时间点，少于 ' + N + ' 条，请扩大时间窗或分批编排');
    const avoid = new Set(cfg.avoid || []);
    const conflict = slot => slot.minute === 0 && avoid.has(slot.hour);
    let best = [], min = Infinity;
    for (let i = 0; i <= slots.length - N; i++) {
      const group = slots.slice(i, i + N), count = group.filter(conflict).length;
      if (count < min) { best = group; min = count; }
      if (!count) break;
    }
    return { slots: best, relaxed: min > 0, conflicts: best.filter(conflict).map(s => s.time) };
  }
  window.BatchSchedule = { plan, candidates };
})();
