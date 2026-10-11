'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 最小 DOM 桩记录真实事件处理器，不给生产代码新增测试入口。
function element() {
  return { style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() {}, select() {}, remove() { this.removed = true; },
    contains(target) { return target === this; }, setAttribute() {},
    getBoundingClientRect() { return { left: 20, bottom: 60 }; }, offsetHeight: 100 };
}
async function page() {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const document = element();
  document.body = { appendChild(el) { document.panel = el; } };
  document.createElement = () => { const el = element(); el.querySelector = () => element(); return el; };
  const context = vm.createContext({ console, Date, Map, Set, document,
    window: { innerWidth: 1000, innerHeight: 800 },
    App: { $, $$: () => [], icon: () => '<svg></svg>', esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
      boot: async () => {}, toast() {}, debounce: fn => fn } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/schedule.js'), 'utf8'), context);
  context.BatchSchedule = context.window.BatchSchedule;
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/batch.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, replan, renderRow, editTitle, buildJobItem, timeOptions, changeTime, renderTable, bindRowEvents, openTimePopover, closeTimePopover }; })();');
  await vm.runInContext(source, context);
  const api = context.window.testing;
  Object.assign(api.state.config, { date: '2026-10-12', start: '10:00', end: '14:00', avoid: [11], prefix: '优香', templateId: 'tpl' });
  api.state.templates = [{ id: 'tpl', variables: [{ key: 'body', type: 'textarea' }], maxImages: 9 }];
  return { ...api, $, document };
}
function row(id) {
  return { id, status: 'ready', title: '', images: [], selectedImages: [], credit: '作者', variables: {}, manualTitle: false, scheduledAt: '', collision: false };
}

test('双击标题保存发布生效，manualTitle=true 且重排不覆盖', async () => {
  const p = await page();
  const a = row('a'), b = row('b');
  p.state.rows = [a, b]; p.replan();
  const cell = element(), input = element(), count = element();
  cell.querySelector = selector => selector === 'input' ? (cell.innerHTML ? input : null) : count;
  const tr = element(); tr.dataset.rowId = 'a';
  tr.querySelector = selector => selector === '[data-edit-title]' ? cell : element();
  const box = element(); box.querySelectorAll = selector => selector === '[data-row-id]' ? [tr] : [];
  p.bindRowEvents(box);
  cell.listeners.dblclick({ currentTarget: cell });
  assert.match(cell.innerHTML, /maxlength="20"/);
  input.value = '手动标题'; input.listeners.input();
  assert.equal(count.textContent, '4/20');
  input.listeners.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(a.title, '手动标题'); assert.equal(a.manualTitle, true);
  assert.equal(p.buildJobItem(a).title, '手动标题');
  p.state.rows = [a]; p.replan();
  assert.equal(a.title, '手动标题');
  // Esc 不保存，失焦保存；未手动标题仍按排期生成。
  cell.innerHTML = ''; p.editTitle(a, cell); input.value = '取消标题';
  input.listeners.keydown({ key: 'Escape', preventDefault() {} });
  input.listeners.blur(); assert.equal(a.title, '手动标题');
  cell.innerHTML = ''; p.editTitle(a, cell); input.value = '失焦标题'; input.listeners.blur();
  assert.equal(a.title, '失焦标题');
  p.state.rows = [a, b]; p.replan(); assert.match(b.title, /13:00/);
});

test('时钟浮层列全整点，改时间仅影响该行并双向标记撞点', async () => {
  const p = await page(); const a = row('a'), b = row('b'), c = row('c');
  p.state.rows = [a, b, c]; p.replan();
  const beforeB = b.scheduledAt, beforeC = c.scheduledAt;
  const options = p.timeOptions(a);
  assert.equal(options.length, 5);
  assert.match(options.find(s => s.hour === 11).label, /避让点/);
  assert.match(options.find(s => s.scheduledAt === beforeB).label, /已被其他行占用/);
  const anchor = element(); p.openTimePopover(a, anchor);
  assert.match(p.document.panel.innerHTML, /已被其他行占用/);
  const index = options.findIndex(s => s.scheduledAt === beforeB);
  p.document.panel.listeners.click({ target: { closest: () => ({ dataset: { slot: String(index) } }) } });
  assert.equal(a.scheduledAt, beforeB); assert.equal(b.scheduledAt, beforeB); assert.equal(c.scheduledAt, beforeC);
  assert.equal(a.collision, true); assert.equal(b.collision, true); assert.equal(c.collision, false);
  assert.notEqual(p.$('#collision-warn').style.display, 'none');
  assert.match(p.renderRow(a, 0), /is-collision/); assert.match(a.title, /13:00/);
  assert.equal(p.document.panel.removed, true);
  a.manualTitle = true; a.title = '保留'; p.changeTime(a, options[0]); assert.equal(a.title, '保留');
  p.openTimePopover(a, anchor); p.document.listeners.keydown({ key: 'Escape' }); assert.equal(p.document.panel.removed, true);
  p.openTimePopover(a, anchor); p.document.listeners.click({ target: element() }); assert.equal(p.document.panel.removed, true);
});

test('操作列桌面与卡片仅两个按钮，无上移下移入口', async () => {
  const p = await page(); const a = row('a');
  p.state.rows = [a]; p.replan();
  const html = p.renderRow(a, 0);
  const actions = html.match(/<td class="batch-cell batch-row-actions">([\s\S]*?)<\/td>/)[1];
  assert.equal((actions.match(/<button/g) || []).length, 2);
  assert.match(actions, /修改动态/); assert.match(actions, /icon-btn danger/); assert.match(actions, /aria-label="删除"/);
  assert.doesNotMatch(html, /上移|下移|moveRow/);
  assert.match(html, /aria-label="修改计划时间"/);
  // 卡片布局复用同一行与操作列，编辑按钮展开已有行编辑区域。
  a.editorOpen = true; assert.match(p.renderRow(a, 0), /batch-row-editor/);
});
