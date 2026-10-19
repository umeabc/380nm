/* UI2「磁吸贴白卡改版 + 待发布图片角标」源码契约测试
 * 纯源码断言：不启动服务、不依赖浏览器，也不改动任何生产入口。
 * 覆盖：静态资源版本、tile DOM 结构、release 角标判定、common 零改动、追加型 CSS。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const pages = fs.readdirSync(path.join(root, 'public'))
  .filter((f) => f.endsWith('.html'))
  .sort();
/* 开发辅助入口不做视觉改版，也不引用共享静态资源 */
const formalPages = pages.filter((f) => !f.startsWith('_'));

test('静态资源统一 V=24：无 v23 残留，缩略图 ?w= 未被误改', () => {
  for (const f of formalPages) {
    const html = read('public/' + f);
    assert.doesNotMatch(html, /v=2[3]/, `${f} 仍有上一版版本号`);
    assert.match(html, /\/css\/app\.css\?v=24/, `${f} 未使用 app.css?v=24`);
    const scripts = html.match(/<script[^>]+src="[^"]+"/g) || [];
    assert.ok(scripts.length > 0, `${f} 缺少脚本引用`);
    for (const s of scripts) assert.match(s, /\?v=24"/, `${f} 脚本版本不是 24：${s}`);
  }
  // batch 另有 schedule.js，同样不得混版
  assert.match(read('public/batch.html'), /src="\/js\/schedule\.js\?v=24"/);
  // 缩略图尺寸仍是 API 参数，不参与静态版本号
  const common = read('public/js/common.js');
  assert.match(common, /function imageSrc\(image, w = 240\)/);
  assert.match(common, /\[240, 480\]\.includes\(w\)/);
  assert.match(common, /'\?w=' \+ w/);
  assert.doesNotMatch(common, /w=2[34]/);
});

test('release 角标：复用 pendingImageMap/pendTip，仅 #img-grid 单元右上', () => {
  const rel = read('public/js/pages/release.js');
  assert.match(rel, /publishedImageMap, pubTip, pendingImageMap, pendTip \} = App/,
    'release 页必须新增 pendingImageMap/pendTip 解构引用');
  assert.match(rel, /const pendMap = pendingImageMap\(state\.jobs\)/);
  assert.match(rel, /const pend = pendMap\[img\.key\]/);
  assert.match(rel, /pend \? 'pending' : ''/, '待发布需复用 .cell.pending 边框语义');
  assert.match(rel, /class="pend-badge release-pend-badge">待发布<\/span>/);
  assert.match(rel, /pendTip\(pend\)/, 'title 需附 pendTip 安全转义文本');
  // 待发布不追加 ×N：release 文案固定四字
  assert.doesNotMatch(rel, /待发布 ×/);
  // 56px 草稿缩略条不加角标（renderSelected 内不得出现 pend）
  const sel = rel.slice(rel.indexOf('function renderSelected'), rel.indexOf('function renderImageGrid'));
  assert.ok(sel.length > 0, 'renderSelected 必须仍在 renderImageGrid 之前');
  assert.doesNotMatch(sel, /pend/i);
  assert.doesNotMatch(sel, /pub-badge/);
  // 角标只在 #img-grid 内产生
  const grid = rel.slice(rel.indexOf('function renderImageGrid'), rel.indexOf('function toggleImage'));
  assert.match(grid, /\$\('#img-grid'\)\.innerHTML/);
  assert.match(grid, /release-pend-badge/);
});

test('common.js 零改动：发布图片映射契约与 shared 逻辑未被改写', () => {
  const common = read('public/js/common.js');
  // 待发布只统计 pending/publishing
  const pendFn = common.slice(common.indexOf('function pendingImageMap'), common.indexOf('function pendTip'));
  assert.match(pendFn, /\['pending', 'publishing'\]\.includes\(j\.status\)/);
  assert.match(pendFn, /j\.scheduledAt/);
  // 已发布仍按 published
  const pubFn = common.slice(common.indexOf('function publishedImageMap'), common.indexOf('function pubTip'));
  assert.match(pubFn, /j\.status !== 'published'/);
  // 导出契约保持不变
  assert.match(common, /publishedImageMap, pubTip, pendingImageMap, pendTip, uploadImages, boot/);
  // 本次改版不得把 tile 体系写进共享脚本
  assert.doesNotMatch(common, /tile|release-pend|磁吸/);
});

test('app.css 为末尾追加的 tile 体系，Token 与关键类齐全', () => {
  const css = read('public/css/app.css');
  for (const token of ['--bg:#F0F1F3', '--tile-radius:14px', '--tile-gap:24px', '--tile-pad:24px',
    '--tile-shadow:', '--tile-shadow-hover:', '--tile-motion:160ms ease',
    '--badge-pending-image-bg:rgba(217,119,6,.94)', '--badge-published-image-bg:rgba(22,163,74,.92)']) {
    assert.ok(css.includes(token), `缺少 token ${token}`);
  }
  for (const cls of ['.tile-page{', '.tile-board{', '.tile{', '.tile--flush{', '.tile-head{',
    '.tile-title{', '.tile-meta{', '.tile-actions{', '.tile-body{', '.tile-foot{',
    '.tile--interactive{', '.tile-kv{', '.tile-stat{', '.tile-stack{', '.tile-empty',
    '.release-pend-badge{', '.dashboard-stats', '.release-compose', '.queue-filters',
    '.library-content', '.batch-board', '.job-board']) {
    assert.ok(css.includes(cls), `缺少样式 ${cls}`);
  }
  // release 角标定位：右上、不拦截点击、随 cell 定位
  const badge = css.slice(css.indexOf('.release-pend-badge{'));
  const block = badge.slice(0, badge.indexOf('}'));
  assert.match(block, /top:4px/);
  assert.match(block, /right:4px/);
  assert.match(block, /bottom:auto/);
  assert.match(block, /pointer-events:none/);
  assert.match(block, /z-index:1/);
  // 图片语义角标统一 pill
  assert.match(css, /\.pend-badge,\.pub-badge\{border-radius:999px\}/);
  // 只允许 transform/box-shadow 动效
  assert.doesNotMatch(css, /transition:\s*all/i);
  // 弹层不套 tile、不因 tile 提升层级
  assert.doesNotMatch(css, /\.mask[^{]*\.tile/);
  assert.doesNotMatch(css, /\.modal[^{]*\.tile/);
  // 账号页选择器链保留，只在 tile-page 下把 margin-top 归零
  assert.match(css, /\.tile-page \.card\.mt\.tile\{margin-top:0\}/);
  // 内容断点与外壳断点分离：tile 布局用 767/768，不新增 720 抽屉阈值
  assert.match(css, /@media\(max-width:767px\)/);
  assert.match(css, /@media\(min-width:768px\) and \(max-width:1279px\)/);
  assert.match(css, /@media\(min-width:1280px\)/);
});

test('dashboard：4 指标 / 柱图 / 环图 / 最近发布全部显式 tile', () => {
  const html = read('public/dashboard.html');
  assert.match(html, /class="page tile-page dashboard-page"/);
  assert.match(html, /class="tile-board dashboard-board"/);
  assert.equal((html.match(/class="stat-card tile tile-stat"/g) || []).length, 4, '四个指标都必须显式迁移');
  assert.match(html, /class="card tile chart-card dashboard-plan"/);
  assert.match(html, /class="card tile ring-card dashboard-rate"/);
  assert.match(html, /class="card tile dashboard-recent"/);
  assert.match(html, /class="tile-head"><h2 class="tile-title">发布成功率<\/h2>/);
  assert.doesNotMatch(html, /ov-grid/, '旧两栏包装必须移除');
  for (const id of ['st-pending', 'st-next', 'st-published', 'st-last', 'st-failed', 'st-rate',
    'ov-bars', 'ov-ring', 'ov-ring-v', 'dash-recent']) {
    assert.ok(html.includes(`id="${id}"`), `缺少原 ID #${id}`);
  }
  assert.match(read('public/js/pages/dashboard.js'), /class="pct"/, '百分号改用类而不是内联字号');
  assert.doesNotMatch(read('public/js/pages/dashboard.js'), /<img/);
});

test('release：图文 / 设置 / 抓取配图 / 提交四张独立卡，字段 ID 唯一且未丢', () => {
  const html = read('public/release.html');
  assert.match(html, /class="page tile-page release-page"/);
  assert.match(html, /class="tile-board release-board"/);
  assert.match(html, /class="tile release-compose"/);
  assert.match(html, /class="tile release-settings"/);
  assert.match(html, /class="tile release-fetchimg"/);
  assert.match(html, /class="tile release-submit"/);
  assert.equal((html.match(/class="release-section"/g) || []).length, 4, '图文与抓取配图卡内共四个小分区');
  assert.match(html, /class="tile-foot"/);
  for (const id of ['no-account-warn', 'dyn-title', 'titleCounter', 'var-fields', 'var-people',
    'var-topic', 'var-at', 'link-input', 'btn-parse', 'fetchState', 'creditInput', 'btn-insert-credit',
    'imgHint', 'pick-upload-btn', 'file-input', 'sel-strip', 'pick-folders', 'img-grid', 'pick-pager',
    'sel-account', 'sel-template', 'tplHint', 'time-input', 'presets', 'preview-text',
    'composeSummary', 'btn-submit']) {
    assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `#${id} 必须唯一存在`);
  }
  // 时间/预设留在设置卡，话题与 @ 仍在模板变量上下文，链接抓取与配图整体移入独立卡
  const settings = html.slice(html.indexOf('release-settings'), html.indexOf('release-fetchimg'));
  assert.match(settings, /id="time-input"/);
  assert.match(settings, /id="presets"/);
  assert.match(settings, /id="sel-account"/);
  const compose = html.slice(html.indexOf('release-compose'), html.indexOf('release-settings'));
  assert.match(compose, /id="var-topic"/);
  assert.match(compose, /id="var-at"/);
  assert.doesNotMatch(compose, /id="img-grid"/, '配图不得留在待发图文卡');
  const fetchimg = html.slice(html.indexOf('release-fetchimg'), html.indexOf('release-submit'));
  assert.match(fetchimg, /id="link-input"/);
  assert.match(fetchimg, /id="img-grid"/);
  assert.match(fetchimg, /id="pick-folders"/);
  assert.match(fetchimg, /id="sel-strip"/);
  // DOM 顺序固定，靠 grid-column 定位而非 order
  const order = ['release-compose', 'release-settings', 'release-fetchimg', 'release-submit']
    .map((c) => html.indexOf(c));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'DOM 顺序必须固定');
  assert.doesNotMatch(read('public/css/app.css'), /\.release-[^{]*\{[^}]*[;{]order:/, '不得用 order 改布局');
});

test('queue：筛选卡 + 分组白卡由 HTML 与 JS 共同保持', () => {
  const html = read('public/queue.html');
  assert.match(html, /class="page tile-page queue-page"/);
  assert.match(html, /class="tile-stack"/);
  assert.match(html, /class="tile queue-filters"/);
  assert.match(html, /class="toolbar tile-head"/);
  assert.match(html, /<div id="list" class="tile-stack"><\/div>/);
  const js = read('public/js/pages/queue.js');
  assert.match(js, /class="metric tile tile-stat"/);
  assert.match(js, /class="group tile tile--flush \$\{col \? 'collapsed' : ''\}"/, '分组必须保留折叠类');
  assert.match(js, /class="group tile tile--flush">/, '不分组时同样是白卡');
  assert.match(js, /class="group-head tile-head" data-toggle=/);
  assert.match(js, /class="group-body tile-body"/);
  assert.match(js, /class="empty tile"/, '空列表为单张 empty.tile');
  // 任务行本身不升格为磁吸贴
  assert.doesNotMatch(js, /class="task tile/);
});

test('library / accounts / batch / 其余页面外壳贴合', () => {
  const lib = read('public/library.html');
  assert.match(lib, /class="tile-board library-board"/);
  assert.match(lib, /class="card tile library-folders"/);
  assert.match(lib, /class="card tile library-content"/);
  assert.doesNotMatch(lib, /class="split"/, '旧 split 列宽包装必须替换');
  for (const id of ['folder-list', 'btn-folder-new', 'storage-bar', 'lib-toolbar', 'lib-pubfilter', 'lib-grid', 'move-menu']) {
    assert.ok(lib.includes(`id="${id}"`), `缺少原 ID #${id}`);
  }

  const acc = read('public/accounts.html');
  assert.match(acc, /class="page tile-page accounts-page"/);
  assert.match(acc, /class="card tile"/);
  assert.match(acc, /class="card mt tile"/, '必须保留 .card.mt 选择器链');
  assert.match(acc, /class="card-h tile-head qrcode-add-head"/);
  assert.match(acc, /id="acc-list"/);

  const batch = read('public/batch.html');
  assert.match(batch, /class="page batch-page tile-page"/);
  assert.match(batch, /class="batch-layout tile-board batch-board"/);
  assert.match(batch, /class="card batch-config tile"/);
  assert.match(batch, /class="card batch-output tile"/);
  assert.match(batch, /class="card-h tile-head batch-output-head"/);
  assert.match(batch, /class="empty batch-empty tile-empty"/);
  // 弹层仍是独立 .mask/.modal，不套 tile
  assert.match(batch, /class="modal batch-confirm"/);
  assert.doesNotMatch(batch, /class="[^"]*modal[^"]*tile/);

  assert.match(read('public/login.html'), /class="login-card tile"/);
  assert.match(read('public/libaccounts.html'), /class="group tile tile--flush"/);
  assert.match(read('public/libaccounts.html'), /class="card-head tile-head"/);
  assert.match(read('public/libaccounts.html'), /class="card-body tile-body"/);
  assert.match(read('public/users.html'), /class="card tile"/);
  assert.match(read('public/users.html'), /class="card mt tile"/);
  assert.match(read('public/templates.html'), /class="pagehead tile"/);
  assert.match(read('public/templates.html'), /class="tile templates-card"/);
  assert.match(read('public/template-edit.html'), /class="card tile" style="max-width:760px"/);
  assert.match(read('public/settings.html'), /class="card tile" style="max-width:680px"/);
  assert.match(read('public/log.html'), /class="card tile"/);
  assert.match(read('public/danbooru.html'), /class="card tile"/);
  assert.match(read('public/job.html'), /class="page tile-page"/);

  const job = read('public/js/pages/job.js');
  assert.match(job, /class="grid2 tile-board job-board"/);
  assert.match(job, /class="stack tile-stack"/);
  assert.match(job, /class="card tile"/);
  assert.match(job, /class="dl tile-kv"/);
  assert.doesNotMatch(job, /style="padding:16px 18px"/, '必须清理迁移实例上的旧内联 padding');
  // 详情页仍按原 imageSrc 尺寸取图
  assert.equal((job.match(/App\.imageSrc\(/g) || []).length, 2);
});

test('每个页面内 id 唯一：半搬移不得留下重复 ID', () => {
  for (const f of pages) {
    const html = read('public/' + f);
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const seen = new Set();
    for (const id of ids) {
      assert.ok(!seen.has(id), `${f} 存在重复 id：${id}`);
      seen.add(id);
    }
  }
});

test('tile-empty 只用于卡内空态，不再套第二层阴影', () => {
  assert.match(read('public/js/pages/dashboard.js'), /class="empty tile-empty"/);
  assert.match(read('public/js/pages/library.js'), /class="mini-empty tile-empty"/);
  assert.match(read('public/js/pages/job.js'), /class="empty tile-empty"/);
  assert.match(read('public/js/pages/users.js'), /class="empty tile-empty"/);
  assert.match(read('public/js/pages/templates.js'), /class="empty tile-empty"/);
  const css = read('public/css/app.css');
  const rule = css.slice(css.indexOf('.tile-empty'), css.indexOf('.tile-empty') + 200);
  assert.match(rule, /border:0/);
  assert.match(rule, /box-shadow:none/);
  assert.match(rule, /background:none/);
});
