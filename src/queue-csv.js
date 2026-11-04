'use strict';
/**
 * 发布队列 CSV 导出/导入共用逻辑。
 *
 * 列顺序固定、表头中文：
 *   标题,计划时间,类型,账号,模板,正文,话题,配图,提及
 *
 * - 计划时间：导出 `iso:<ISO带偏移>`；导入接受 `iso:` 前缀（带偏移）或裸
 *   `YYYY-MM-DD HH:mm`（按 +08:00 解释）。
 * - 话题：`{"id":"...","name":"..."}` 或空。
 * - 配图：JSON 数组 `["a.jpg","b.jpg"]`（保序）。
 * - 提及：JSON 数组，原样（可为空 `[]`）。
 * - 公式注入防护：任何以 `=` `+` `-` `@` 开头的单元格导出时前置一个 `'`，
 *   导入时剥掉一层 `'`。
 * - 单元格超过 32000 字符：Excel 单元格上限 32767，导出时该任务整体失败。
 */

const { sniffImageFormat } = require('./image-format');
const CSV_HEADERS = ['标题', '计划时间', '类型', '账号', '模板', '正文', '话题', '配图', '提及'];
const TASK_TYPE_SET = new Set(['原创', '翻嵌', '翻译', '转载']);
const CSV_TYPE_SET = TASK_TYPE_SET; // 别名：routes 侧使用
const MAX_CELL_CHARS = 32000; // Excel 单元格上限 32767，留余量
const TZ_OFFSET = '+08:00';

/** RFC4180：包裹含逗号/引号/换行的单元格，内部引号翻倍 */
function csvEscape(cell) {
  const s = String(cell == null ? '' : cell);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 公式注入防护：以 = + - @ 开头的单元格前置 `'` */
function csvGuard(cell) {
  const s = String(cell == null ? '' : cell);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** 导入：剥掉一层导出时加的 `'` 前缀 */
function csvUnguard(cell) {
  return /^'/.test(cell) ? cell.slice(1) : cell;
}

/**
 * 文件名清洗（zip 内图片条目名）：
 * 替换 [\\/:*?"<>|\r\n\t] → `_`，去首尾点与空格，截断 120 字符，空则 `image`。
 */
function sanitizeZipName(name) {
  let s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_');
  s = s.replace(/^[. ]+/, '').replace(/[. ]+$/, '');
  if (s.length > 120) s = s.slice(0, 120);
  s = s.replace(/[. ]+$/, '');
  return s || 'image';
}

/** 以 +08:00 偏移格式化时间：iso:2026-11-05T14:00:00+08:00 */
function formatCsvTime(date) {
  const d = new Date(date);
  // 转到 +08:00 表示（本地即 +08:00，直接算偏移量）
  const offMin = -d.getTimezoneOffset(); // 分钟
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const pad = (n) => String(n).padStart(2, '0');
  const local = new Date(d.getTime() + offMin * 60000);
  const iso = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return 'iso:' + iso;
}

/**
 * 解析 CSV 计划时间列。
 * 接受：
 *  - `iso:2026-11-05T14:00:00+08:00`（必须带偏移）
 *  - `2026-11-05 14:00`（裸格式，按 +08:00 解释）
 * 返回 Date；非法返回 null。
 */
function resolveCsvTime(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (s.startsWith('iso:')) {
    const rest = s.slice(4);
    // 必须带偏移（Z 或 ±hh:mm）
    if (!/(Z|[+-]\d{2}:\d{2})$/i.test(rest)) return null;
    const d = new Date(rest);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00${TZ_OFFSET}`);
  return isNaN(d.getTime()) ? null : d;
}

/** 把任务行转成 CSV 单元格数组（不含表头） */
function jobToCsvCells(job, imageNames) {
  const topic = job.topic && job.topic.name
    ? JSON.stringify({ id: job.topic.id, name: job.topic.name })
    : '';
  const cells = [
    String(job.title || ''),
    formatCsvTime(job.scheduledAt),
    String(job.type || '原创'),
    String(job.accountName || ''),
    String(job.templateName || ''),
    String(job.text || ''),
    topic,
    JSON.stringify(imageNames || []),
    JSON.stringify(Array.isArray(job.mentions) ? job.mentions : [])
  ];
  return cells;
}

/** 把一行任务数据序列化成 CSV 行文本（含换行符结尾） */
function csvRow(cells) {
  return cells.map(c => csvEscape(csvGuard(c))).join(',') + '\r\n';
}

/**
 * 生成 queue.csv 内容（UTF-8 带 BOM 的文本；BOM 由调用方写 Buffer 时加）。
 * rows: [jobToCsvCells 的结果...]
 */
function buildQueueCsv(rows) {
  const lines = [csvRow(CSV_HEADERS)];
  for (const cells of rows) {
    // 超长单元格直接抛错（Excel 上限 32767，留余量）
    for (const c of cells) {
      if (String(c).length > MAX_CELL_CHARS) {
        throw new Error('正文或字段超过 32000 字符，超出 Excel 单元格上限，无法导出为 CSV');
      }
    }
    lines.push(csvRow(cells));
  }
  return lines.join('');
}

/* ---------------- CSV 解析（RFC4180） ---------------- */

/**
 * 解析 CSV 文本为二维数组（保留引号内换行）。支持 \r\n 与 \n。
 */
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell); cell = '';
    } else if (ch === '\n') {
      row.push(cell); cell = '';
      rows.push(row); row = [];
    } else if (ch === '\r') {
      // 忽略，等 \n
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * 解析 queue.csv 文本（自动剥 BOM）为对象行。
 * 空行与 `#` 开头的注释行标记 skipped: true。
 * 表头缺失必需列时抛错。
 */
function parseQueueCsv(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const raw = parseCsv(s);
  if (!raw.length) throw new Error('queue.csv 是空的');
  const header = raw[0].map(h => csvUnguard(String(h).trim()));
  const variableFormat = !header.includes('类型') && !header.includes('账号') && header.includes('模板');
  // Variable-format title labels are resolved after matching the template.
  const missing = (variableFormat ? ['模板', '计划时间', '配图', '提及'] : CSV_HEADERS).filter(h => !header.includes(h) && !(h === '标题' && header.includes('title')));
  if (missing.length) {
    throw new Error(`queue.csv 缺少必需列: ${missing.join('、')}`);
  }
  const idx = {};
  for (let i = 0; i < header.length; i++) idx[header[i]] = i;
  const rows = [];
  for (let r = 1; r < raw.length; r++) {
    const cells = raw[r];
    const line = r + 1; // CSV 行号（表头为第 1 行）
    // 空行：整行仅一个空单元格
    const isEmpty = cells.every(c => String(c).trim() === '');
    if (isEmpty) { rows.push({ row: line, skipped: true, reason: '空行' }); continue; }
    const first = String(cells[0] || '').trim();
    if (first.startsWith('#')) { rows.push({ row: line, skipped: true, reason: '注释行' }); continue; }
    const get = (h) => csvUnguard(String(cells[idx[h]] == null ? '' : cells[idx[h]]));
    rows.push({
      row: line,
      csvCells: Object.fromEntries(header.map((h, i) => [h, csvUnguard(String(cells[i] ?? ''))])),
      ...(variableFormat ? { variableCells: Object.fromEntries(header.map((h, i) => [h, csvUnguard(String(cells[i] ?? ''))])) } : {}),
      title: get('标题').trim(),
      scheduledAt: get('计划时间').trim(),
      type: get('类型').trim() || (variableFormat ? '原创' : ''),
      accountName: get('账号').trim(),
      templateName: get('模板').trim(),
      text: get('正文'),
      topic: get('话题').trim(),
      images: get('配图').trim(),
      mentions: get('提及').trim()
    });
  }
  return rows;
}

/* ---------------- 图片魔数 ---------------- */

const MAGIC_BY_EXT = {
  jpg: 'jpeg', jpeg: 'jpeg', png: 'png', gif: 'gif',
  webp: 'webp', bmp: 'bmp', avif: 'avif'
};

/** 复用基础位图检测，保留 CSV 独有的 AVIF 识别分支。 */
function magicForImage(buf) {
  const format = sniffImageFormat(buf);
  if (format) return format;
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x66 && buf[1] === 0x74 && buf[2] === 0x79 && buf[3] === 0x70) {
    const brand = buf.slice(8, 12).toString('latin1');
    if (/^(avif|avis)/.test(brand)) return 'avif';
  }
  return null;
}

/** 扩展名与魔数是否一致 */
function imageExtMatchesMagic(ext, buf) {
  const want = MAGIC_BY_EXT[String(ext).toLowerCase().replace(/^\./, '')];
  if (!want) return false;
  const got = magicForImage(buf);
  return got === want;
}

/** 由魔数推断 contentType（入库用） */
function contentTypeForMagic(kind) {
  return {
    jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', avif: 'image/avif'
  }[kind] || 'application/octet-stream';
}

module.exports = {
  CSV_HEADERS, TASK_TYPE_SET, CSV_TYPE_SET, MAX_CELL_CHARS, TZ_OFFSET,
  csvEscape, csvGuard, csvUnguard, sanitizeZipName,
  formatCsvTime, resolveCsvTime, jobToCsvCells, csvRow, buildQueueCsv,
  parseCsv, parseQueueCsv,
  magicForImage, imageExtMatchesMagic, contentTypeForMagic
};
