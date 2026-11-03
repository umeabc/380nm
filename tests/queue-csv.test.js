/* 测试：queue.csv 编解码（含逗号/换行/引号的正文往返、BOM、iso: 时间、配图 JSON 保序、公式前缀） */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  CSV_HEADERS, buildQueueCsv, parseQueueCsv, jobToCsvCells,
  formatCsvTime, resolveCsvTime, sanitizeZipName, csvGuard, csvUnguard, parseCsv
} = require('../src/queue-csv');

describe('queue.csv 编解码', () => {
  const mkJob = (over = {}) => Object.assign({
    title: 'T', scheduledAt: '2026-11-05T06:00:00.000Z', type: '原创',
    accountName: 'acc', templateName: 'tpl', text: '正文', topic: null, mentions: []
  }, over);

  it('表头顺序固定且中文', () => {
    assert.deepStrictEqual(CSV_HEADERS,
      ['标题', '计划时间', '类型', '账号', '模板', '正文', '话题', '配图', '提及']);
  });

  it('简单行往返', () => {
    const cells = jobToCsvCells(mkJob(), ['a.jpg']);
    const csv = buildQueueCsv([cells]);
    const rows = parseQueueCsv(csv);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].title, 'T');
    assert.strictEqual(rows[0].text, '正文');
    assert.strictEqual(rows[0].images, JSON.stringify(['a.jpg']));
  });

  it('含逗号/换行/引号的正文往返', () => {
    const text = '第一行，含逗号\n第二行含"引号"和,半角\n第三行';
    const cells = jobToCsvCells(mkJob({ text }), ['x.jpg']);
    const csv = buildQueueCsv([cells]);
    const rows = parseQueueCsv(csv);
    assert.strictEqual(rows[0].text, text);
  });

  it('BOM 存在且导入解析兼容 BOM', () => {
    const csv = buildQueueCsv([jobToCsvCells(mkJob(), [])]);
    const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(csv, 'utf8')]);
    // BOM 后的前三字节
    assert.strictEqual(buf[0], 0xEF); assert.strictEqual(buf[1], 0xBB); assert.strictEqual(buf[2], 0xBF);
    const rows = parseQueueCsv(buf.toString('utf8'));
    assert.strictEqual(rows.length, 1);
  });

  it('iso: 时间带偏移导出并可解析', () => {
    const s = formatCsvTime(new Date('2026-11-05T14:00:00+08:00'));
    assert.match(s, /^iso:2026-11-05T14:00:00\+08:00$/);
    const d = resolveCsvTime(s);
    assert.strictEqual(d.toISOString(), '2026-11-05T06:00:00.000Z');
  });

  it('裸 YYYY-MM-DD HH:mm 按 +08:00 解释', () => {
    const d = resolveCsvTime('2026-11-05 14:00');
    assert.strictEqual(d.toISOString(), '2026-11-05T06:00:00.000Z');
  });

  it('iso: 无偏移 → 拒绝', () => {
    assert.strictEqual(resolveCsvTime('iso:2026-11-05T14:00:00'), null);
  });

  it('非法时间 → null', () => {
    assert.strictEqual(resolveCsvTime(''), null);
    assert.strictEqual(resolveCsvTime('not a time'), null);
    assert.strictEqual(resolveCsvTime('iso:garbage'), null);
  });

  it('配图 JSON 保序', () => {
    const names = ['a.jpg', 'b.jpg', 'c.png'];
    const cells = jobToCsvCells(mkJob(), names);
    const csv = buildQueueCsv([cells]);
    const rows = parseQueueCsv(csv);
    assert.deepStrictEqual(JSON.parse(rows[0].images), names);
  });

  it('话题对象导出', () => {
    const cells = jobToCsvCells(mkJob({ topic: { id: 1, name: '测试话题' } }), []);
    const rows = parseQueueCsv(buildQueueCsv([cells]));
    assert.deepStrictEqual(JSON.parse(rows[0].topic), { id: 1, name: '测试话题' });
  });

  it('公式前缀防护：= + - @ 开头加引号，导入剥掉一层', () => {
    assert.strictEqual(csvGuard('=SUM(A1)'), "'=SUM(A1)");
    assert.strictEqual(csvGuard('+x'), "'+x");
    assert.strictEqual(csvGuard('-1'), "'-1");
    assert.strictEqual(csvGuard('@f'), "'@f");
    assert.strictEqual(csvGuard('正常'), '正常');
    assert.strictEqual(csvUnguard("'=SUM(A1)"), '=SUM(A1)');
    assert.strictEqual(csvUnguard("'单引号真名"), '单引号真名'); // 只剥一层
    assert.strictEqual(csvUnguard('abc'), 'abc');
  });

  it('正文以 = 开头导出加保护，导入还原', () => {
    const cells = jobToCsvCells(mkJob({ text: '=cmd|危险' }), []);
    const rows = parseQueueCsv(buildQueueCsv([cells]));
    assert.strictEqual(rows[0].text, '=cmd|危险');
  });

  it('超 32000 字符单元格 → 抛错', () => {
    const long = 'x'.repeat(32001);
    assert.throws(() => buildQueueCsv([jobToCsvCells(mkJob({ text: long }), [])]),
      /32000|32767|超出 Excel/);
  });

  it('缺必需列 → 报缺列', () => {
    assert.throws(() => parseQueueCsv('标题,类型\na,b'), /缺少必需列/);
  });

  it('空行与 # 注释行进 skipped', () => {
    const text = CSV_HEADERS.join(',') + '\r\n# 注释\r\n\r\n' +
      CSV_HEADERS.map((_, i) => i).join(',') + '\r\n';
    // 直接拼手写文本：表头 + 注释 + 空行 + 数据
    const rows = parseQueueCsv(text);
    assert.strictEqual(rows.length, 3);
    assert.ok(rows[0].skipped);
    assert.ok(rows[1].skipped); // 空行
    assert.ok(!rows[2].skipped);
  });

  it('文件名清洗', () => {
    assert.strictEqual(sanitizeZipName('a/b:c?*<>|d.jpg'), 'a_b_c_____d.jpg');
    assert.strictEqual(sanitizeZipName('  .hidden. '), 'hidden');
    assert.strictEqual(sanitizeZipName('...'), 'image');
    assert.strictEqual(sanitizeZipName(''), 'image');
    assert.strictEqual(sanitizeZipName('x'.repeat(130) + '.jpg').length, 120);
  });

  it('parseCsv 支持引号内换行', () => {
    const rows = parseCsv('a,"b\nc",d\r\ne,f,g');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0][1], 'b\nc');
    assert.strictEqual(rows[1][2], 'g');
  });
});
