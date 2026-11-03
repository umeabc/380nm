'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('public/release.html');
const css = read('public/css/app.css') + '\n' + [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
const compact = value => value.replace(/\s+/g, '');
// Inspect declarations from both stylesheets in page order. These are source
// contracts; the browser's media queries and computed geometry need visual QA.
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => {
  const declarations = Object.fromEntries(body.split(';').filter(part => part.includes(':')).map(part => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
  return selectors.split(',').map(selector => ({ selector: selector.trim(), declarations }));
});
function declarations(selector) {
  const matches = rules.filter(rule => compact(rule.selector) === compact(selector));
  assert.ok(matches.length, `Missing release layout rule: ${selector}`);
  return Object.assign({}, ...matches.map(rule => rule.declarations));
}
function section(className) {
  const match = html.match(new RegExp(`<section\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)<\\/section>`));
  assert.ok(match, `Missing release card: ${className}`);
  return match[1];
}
function pixels(value, label) {
  assert.match(value || '', /^\d+(?:\.\d+)?px$/, `${label} must reserve an explicit pixel minimum`);
  return parseFloat(value);
}

test('release images share a horizontal card header with template variables and keep count and upload at the right', () => {
  const images = section('release-images');
  const sidebar = images.match(/<div class="pick-sidebar">([\s\S]*?)<div id="pick-folders"[^>]*><\/div>\s*<\/div>/);
  assert.ok(sidebar, 'The folder list retains its narrow left sidebar');
  const head = images.match(/^\s*<div class="card-head card-h">([\s\S]*?)<\/div>\s*<\/div>\s*<div class="card-body">/);
  assert.ok(head, 'A standard card header is a direct child before the image card body');
  assert.match(section('release-variables'), /^\s*<div class="card-head card-h">/, 'Template variables and images use the same header classes');
  assert.match(head[1], /<span\b[^>]*class="[^"]*\bg-title\b[^"]*"[^>]*>配图<\/span>/);
  const actions = head[1].match(/<div class="hint-r release-image-actions">([\s\S]*)$/);
  assert.ok(actions, 'The count and upload button share the standard right-side helper area');
  assert.match(actions[1], /<span\b[^>]*id="imgHint"[^>]*aria-live="polite"[^>]*>已选 0\/9<\/span>/);
  assert.match(actions[1], /<button\b[^>]*class="btn sm"[^>]*id="pick-upload-btn"[^>]*>上传图片<\/button>/);
  assert.ok(actions[1].indexOf('id="imgHint"') < actions[1].indexOf('id="pick-upload-btn"'), 'Upload is after the count at the far right');
  assert.match(head[1], /class="[^"]*\brelease-image-title\b[^"]*"/);
  assert.doesNotMatch(sidebar[1], /release-image-title|g-title/, 'The title no longer occupies the folder sidebar');
  assert.ok(images.indexOf(head[0]) < images.indexOf('class="pick-right"'), 'The header spans both image columns');
  const title = declarations('.release-page .release-image-title');
  assert.equal(title['white-space'], 'nowrap');
  assert.equal(title['writing-mode'], 'horizontal-tb');
  assert.notEqual(title['text-orientation'], 'upright');
  assert.equal(title['line-height'], undefined, 'The horizontal title inherits the ordinary card title line box');
  assert.equal(title['font-size'], undefined, 'The image title inherits the ordinary card title size');
  assert.equal(title.flex, '0 0 auto', 'The title cannot shrink into the upload controls');
  const left = declarations('.release-page .pick-sidebar');
  assert.equal(left['min-width'], '0');
  assert.equal(left['grid-template-columns'], undefined, 'The sidebar no longer reserves a vertical-title column');
  assert.equal(left.gap, undefined, 'The removed vertical-title column leaves no extra gap');
  const sharedHead = declarations('.release-page .release-board .card-head.card-h');
  assert.equal(sharedHead['min-height'], '48px', 'Both standard headers reserve the same compact height');
  assert.equal(sharedHead.padding, '6px 16px', 'The small upload button fits within the shared header height');
  assert.equal(sharedHead['margin-bottom'], '0');
  assert.equal(sharedHead['font-size'], '14px');
  const headerRules = rules.filter(rule => rule.selector === '.release-page .release-images .card-head');
  assert.equal(headerRules[0].declarations['flex-wrap'], 'nowrap', 'Desktop header stays on one line');
  assert.equal(declarations('.release-page .release-images .card-head')['flex-wrap'], 'wrap', 'Narrow-screen header can grow without clipping its controls');
  assert.match(css, /@media\s*\(max-width:\s*1100px\)\s*\{[^@]*?\.release-page\s+\.release-images\s+\.card-head\s*\{[^}]*flex-wrap:\s*wrap/, 'Header wrapping starts at the 1100px breakpoint');
  assert.notEqual(declarations('.release-page .release-images .card-head').overflow, 'hidden');
  const right = declarations('.release-page .release-image-actions');
  assert.equal(right['flex-wrap'], 'nowrap');
  assert.equal(right['justify-content'], 'flex-end');
  assert.equal(right.gap, '8px');
  assert.equal(declarations('.card-h .hint-r')['margin-left'], 'auto');
  assert.equal(declarations('.release-page #imgHint')['white-space'], 'nowrap');
  assert.equal(declarations('.release-page #imgHint').flex, '0 0 auto');
  assert.equal(declarations('.release-page #pick-upload-btn').flex, '0 0 auto');
  assert.match(actions[1], /<input\b[^>]*type="file"[^>]*id="file-input"[^>]*accept="image\/\*"[^>]*multiple[^>]*style="display:none"/);
});

test('release folders form a compact left column beside a dense natural-ratio grid in a bounded scrollable card', () => {
  const images = section('release-images');
  assert.match(images, /id="pick-folders"/);
  assert.match(images, /id="img-grid"/);
  assert.ok(images.indexOf('id="pick-folders"') < images.indexOf('id="img-grid"'));
  assert.equal(compact(declarations('.release-page .img-layout')['grid-template-columns']), '132pxminmax(0,1fr)');
  const folders = declarations('.release-page #pick-folders');
  assert.equal(folders.display, 'flex');
  assert.equal(folders['flex-wrap'], 'nowrap');
  assert.equal(folders['flex-direction'], 'column');
  assert.equal(folders.gap, '2px');
  assert.equal(folders['max-height'], '270px');
  assert.equal(folders['overflow-y'], 'auto');
  const folder = declarations('.release-page #pick-folders .folder-row');
  assert.equal(folder.height, '28px');
  assert.equal(folder['min-height'], '28px');
  assert.equal(folder.padding, '4px');
  assert.equal(folder.gap, '4px');
  assert.equal(declarations('.folder-row.on').background, 'var(--primary-soft)');
  const name = declarations('.release-page #pick-folders .lib-fname');
  assert.equal(name['white-space'], 'nowrap');
  assert.equal(name.overflow, 'hidden');
  assert.equal(name['text-overflow'], 'ellipsis');
  const right = declarations('.release-page .pick-right');
  assert.equal(right.display, 'flex');
  assert.equal(right['flex-direction'], 'column');
  // The shared desktop rule also targets .img-grid. Read its .thumbs alias so
  // the narrow-screen .img-grid rule does not replace its 92px source contract.
  const sharedGrid = declarations('.thumbs');
  assert.equal(compact(sharedGrid['grid-template-columns']), 'repeat(auto-fill,minmax(92px,1fr))');
  assert.equal(sharedGrid.gap, '10px');
  assert.ok(rules.some(rule => rule.selector === '.img-grid' &&
    rule.declarations['grid-template-columns'] === sharedGrid['grid-template-columns'] &&
    rule.declarations.gap === sharedGrid.gap), 'The shared density also applies to the image grid');
  const grid = declarations('.release-page #img-grid');
  assert.equal(grid['grid-template-columns'], sharedGrid['grid-template-columns'], 'Release thumbnails preserve the 92px density at every viewport width');
  assert.equal(grid.gap, sharedGrid.gap, 'Release thumbnails preserve the shared 10px spacing');
  assert.equal(grid['max-height'], '236px');
  assert.equal(grid.overflow, 'auto');
  const cell = declarations('.release-page #img-grid .cell');
  assert.equal(cell['aspect-ratio'], 'auto');
  assert.equal(cell.overflow, 'hidden');
  assert.equal(cell['min-width'], '0');
  assert.equal(cell['align-self'], 'start', 'Short images do not stretch to the tallest image in a row');
  const image = declarations('.release-page #img-grid .cell img');
  assert.equal(image.height, 'auto');
  assert.equal(image['object-fit'], 'contain');
  const body = declarations('.release-page .release-board .release-images .card-body');
  assert.equal(body.padding, '8px');
  assert.equal(body.gap, '6px');
  assert.equal(body['max-height'], '280px', 'A 280px body, 48px header and two border pixels preserve the 330px card limit');
  assert.equal(body.overflow, 'auto', 'Folders, pagination and selected images remain reachable');
  assert.equal(body.flex, '0 1 auto');
  assert.equal(declarations('.release-page .release-images .card-body>*')['flex-shrink'], '0');
  const hint = declarations('.release-page .release-images .foot-hint');
  assert.equal(hint['font-size'], '11px');
  assert.equal(hint['white-space'], 'nowrap', 'The image instructions occupy only one line');
  assert.equal(hint.overflow, 'hidden');
  assert.equal(hint['text-overflow'], 'ellipsis');
  assert.equal(hint['text-align'], 'right');
  assert.match(images, /<div class="foot-hint" title="按选择顺序发布。左侧切换文件夹；上传存入当前文件夹（全部图片 \/ 未分类时存入未分类）。">按选择顺序发布，左侧切换文件夹，上传存入当前文件夹<\/div>/, 'The shortened hint retains the full upload-folder explanation on hover');
});

test('release composed text retains at least 120px and can scroll internally', () => {
  assert.match(section('release-submit'), /class="preview" id="preview-text"/);
  const preview = declarations('.release-page #preview-text');
  assert.ok(pixels(preview['min-height'], 'Preview') >= 120);
  assert.equal(preview.overflow, 'auto');
});

test('release quick times wrap horizontally without full-width buttons', () => {
  const presets = declarations('.release-page .presets');
  assert.equal(presets.display, 'flex');
  assert.equal(presets['flex-wrap'], 'wrap');
  assert.equal(declarations('.release-page .presets>.chip').flex, '0 0 auto');
  for (const preset of ['today1000', 'today1500', 'today2000', 'tomorrow1000', 'tomorrow1500', 'tomorrow2000', '1h', 'now']) {
    assert.equal((html.match(new RegExp(`data-preset="${preset}"`, 'g')) || []).length, 1);
  }
});

test('release board and submit card size to content without fixed grid rows or viewport heights', () => {
  const board = declarations('.release-page .release-board');
  assert.equal(board['grid-template-rows'], 'auto');
  assert.equal(board.height, 'auto');
  assert.equal(board['max-height'], 'none');
  const columns = rules.filter(rule => compact(rule.selector) === '.release-page.release-column');
  assert.ok(columns.some(rule => rule.declarations.display === 'flex' && rule.declarations['flex-direction'] === 'column'), 'Desktop columns stack their cards by content height');
  const boardRules = rules.filter(rule => /(?:^|\s)\.release-board(?::has\([^{}]*\))?$/.test(rule.selector));
  assert.ok(boardRules.length);
  for (const rule of boardRules) {
    assert.doesNotMatch(rule.declarations['grid-template-rows'] || '', /\d+(?:px|[ds]?vh)/, rule.selector);
    for (const property of ['height', 'max-height']) {
      assert.ok(!rule.declarations[property] || ['auto', 'none'].includes(rule.declarations[property]), `${rule.selector} ${property} must not cap content`);
    }
  }
  const cards = declarations('.release-page .release-board>.release-column>.group');
  assert.equal(cards['max-height'], 'none');
  assert.notEqual(cards.overflow, 'hidden');
});

test('release action footer retains both buttons and page bottom leaves at least 24px', () => {
  const submit = section('release-submit');
  const footer = submit.match(/<div class="card-foot">([\s\S]*?)<\/div>/);
  assert.ok(footer, 'Submit actions remain in the card footer');
  for (const id of ['btn-save-draft', 'btn-submit']) assert.match(footer[1], new RegExp(`<button\\b[^>]*id="${id}"`));
  assert.ok(pixels(declarations('.release-page')['padding-bottom'], 'Release page bottom gap') >= 24);
});

test('release image controls preserve counters, folder filtering, selection order and pending badges', async () => {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '' });
    return elements.get(selector);
  };
  const common = { window: {}, document: {} };
  vm.runInNewContext(read('public/js/common.js'), common);
  const { esc, icon } = common.window.App;
  const context = {
    window: {}, URLSearchParams, location: { search: '' },
    App: { $, $$: () => [], esc, icon,
      imageSrc: image => image.url, publishedImageMap: () => ({}), pubTip: () => '',
      pendingImageMap: () => ({ first: {} }), pendTip: () => '', toast: () => {}, boot: async () => {} }
  };
  const source = read('public/js/pages/release.js').replace(/\}\)\(\);\s*$/,
    'renderSubmit = () => {}; window.testing = { state, renderImageGrid, renderPickFolders, pickUploadFolder, toggleImage, useTemplate(t) { state.templates = [t]; activeTplId = t.id; } }; })();');
  await vm.runInNewContext(source, context);
  const page = context.window.testing;
  page.renderImageGrid();
  assert.equal($('#imgHint').innerHTML, '已选 <span class="ctr">0/9</span>');
  page.useTemplate({ id: 'images', maxImages: 2 });
  page.state.selected = [{ key: 'first' }, { key: 'second' }];
  page.renderImageGrid();
  assert.equal($('#imgHint').innerHTML, '已选 <span class="ctr">2/2</span>');
  page.useTemplate({ id: 'text-only', maxImages: 0 });
  page.renderImageGrid();
  assert.equal($('#imgHint').innerHTML, '已选 <span class="ctr bad">2/0</span>');
  page.state.selected = [];
  page.renderImageGrid();
  assert.equal($('#imgHint').innerHTML, '已选 <span class="ctr">0/0</span>');

  page.useTemplate({ id: 'image-controls', maxImages: 9 });
  page.state.images = [
    { key: 'first', name: '第一张', folderId: 'import', url: 'data:image/png,first' },
    { key: 'second', name: '第二张', url: 'data:image/png,second' },
    { key: 'third', name: '第三张', folderId: 'draft', url: 'data:image/png,third' }
  ];
  page.state.folders = [{ id: 'import', name: '导入 "长名称" & <图集>' }, { id: 'draft', name: '草稿' }];
  page.renderPickFolders();
  const allFolders = $('#pick-folders').innerHTML;
  assert.equal((allFolders.match(/data-fld=/g) || []).length, 4, 'All, unclassified and custom folders remain separate rows');
  const folderIcons = [...allFolders.matchAll(/<svg\b[^>]*class="pick-folder-icon"[^>]*>([\s\S]*?)<\/svg>/g)];
  assert.equal(folderIcons.length, 4, 'Every folder row retains an icon');
  for (const [svg, drawing] of folderIcons) {
    assert.match(svg, /width="12" height="12"/);
    assert.match(drawing, /<path\b[^>]*d="[^"]+"/, 'Folder icons must contain a visible path, not an empty SVG');
  }
  assert.match(allFolders, /class="folder-row on"[^>]*data-fld="all"/);
  assert.match(allFolders, /title="导入 &quot;长名称&quot; &amp; &lt;图集&gt;"/);
  assert.match(allFolders, /全部图片<\/span><span class="cnt">3<\/span>/);
  assert.match(allFolders, /未分类<\/span><span class="cnt">1<\/span>/);
  assert.equal(page.pickUploadFolder(), null);

  page.toggleImage('first');
  page.renderImageGrid();
  assert.equal($('#imgHint').innerHTML, '已选 <span class="ctr">1/9</span>');
  assert.match($('#img-grid').innerHTML, /class="cell on\s+pending" data-key="first"/);
  assert.match($('#img-grid').innerHTML, /<span class="ord">1<\/span>/);
  assert.match($('#img-grid').innerHTML, /class="pend-badge release-pend-badge">待发布<\/span>/);
  assert.match($('#sel-strip').innerHTML, /data-rm="first"/);
  page.toggleImage('second');
  assert.deepEqual(Array.from(page.state.selected, image => image.key), ['first', 'second']);
  assert.match($('#sel-strip').innerHTML, /<span class="ord">2<\/span>/);
  page.toggleImage('first');
  assert.deepEqual(Array.from(page.state.selected, image => image.key), ['second']);
  assert.equal($('#imgHint').innerHTML, '已选 <span class="ctr">1/9</span>');
  assert.doesNotMatch($('#sel-strip').innerHTML, /data-rm="first"/);

  page.state.pickFolder = 'import';
  page.renderPickFolders();
  page.renderImageGrid();
  assert.match($('#pick-folders').innerHTML, /class="folder-row on"[^>]*data-fld="import"/);
  assert.match($('#img-grid').innerHTML, /data-key="first"/);
  assert.doesNotMatch($('#img-grid').innerHTML, /data-key="(?:second|third)"/);
  assert.equal(page.pickUploadFolder(), 'import');
  assert.equal($('#imgHint').innerHTML, '已选 <span class="ctr">1/9</span>', 'Changing folders preserves the selected-image count');
  page.state.pickFolder = 'none';
  page.renderImageGrid();
  assert.match($('#img-grid').innerHTML, /data-key="second"/);
  assert.doesNotMatch($('#img-grid').innerHTML, /data-key="(?:first|third)"/);
  assert.equal(page.pickUploadFolder(), null);
  assert.match(source, /\$\('#pick-upload-btn'\)\.addEventListener\('click', \(\) => \$\('#file-input'\)\.click\(\)\)/);
  assert.match(source, /\$\('#file-input'\)\.addEventListener\('change',[\s\S]*?uploadFiles\(\$\('#file-input'\)\.files\)/);
  assert.match(source, /\$\('#pick-folders'\)\.addEventListener\('click',[\s\S]*?state\.pickPage = 1;[\s\S]*?renderPickFolders\(\);\s*renderImageGrid\(\);/);
});
