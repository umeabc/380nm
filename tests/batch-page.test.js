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
  let uuidCounter = 0;
  const apiCalls = [];
  const dialogCalls = [];
  let dialogLoading = false;
  const apiFn = async (method, url, body) => {
    apiCalls.push({ method, url, body });
    if (method === 'GET' && url === '/api/batch-draft') return { revision: 0, rows: [], config: {} };
    if (method === 'PUT' && url === '/api/batch-draft') return { revision: (body.revision || 0) + 1, rows: body.rows, config: body.config };
    if (method === 'POST' && url === '/api/batch-draft/enqueue') return {
      revision: (body.revision || 0) + 1,
      rows: [],
      created: body.rowIds.map(rowId => ({ rowId })),
      failed: []
    };
    throw new Error(`unexpected api call: ${method} ${url}`);
  };
  const fetch = async () => {
    const payload = new TextEncoder().encode(JSON.stringify({
      type: 'done',
      work: { platform: 'x', author: '测试作者', handle: 'artist' },
      images: []
    }) + '\n');
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: { getReader: () => ({
        read: async () => sent ? { done: true } : (sent = true, { done: false, value: payload }),
        cancel() {}
      }) }
    };
  };
  const context = vm.createContext({ console, Date, Map, Set, document, fetch,
    AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    crypto: { randomUUID: () => `uuid-${++uuidCounter}` },
    window: { innerWidth: 1000, innerHeight: 800 },
    App: { $, $$: () => [], api: apiFn, icon: () => '<svg></svg>', imageSrc: image => image?.url || '', esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
      boot: async () => {}, toast() {}, debounce: fn => fn },
    ConfirmDialog: { create: () => ({
      open() { dialogCalls.push('open'); },
      close() {
        if (dialogLoading) {
          dialogCalls.push('close-while-loading');
          return false;
        }
        dialogCalls.push('close');
        return true;
      },
      setLoading(value) {
        dialogLoading = value;
        dialogCalls.push(`setLoading(${value})`);
      }
    }) } });
  // 加载 near-time.js
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/near-time.js'), 'utf8'), context);
  context.NearTime = context.window.NearTime;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/schedule.js'), 'utf8'), context);
  context.BatchSchedule = context.window.BatchSchedule;
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/batch.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, startParsing, finalizeParsing, replan, renderProgress, renderRow, editTitle, buildJobItem, timeOptions, changeTime, renderTable, bindRowEvents, openTimePopover, closeTimePopover, showConfirm, confirmEnqueue, abortParsing }; })();');
  await vm.runInContext(source, context);
  const api = context.window.testing;
  Object.assign(api.state.config, { date: '2026-10-12', start: '10:00', end: '14:00', avoid: [11], prefix: '优香', templateId: 'tpl', accountId: 'acc1' });
  api.state.templates = [{ id: 'tpl', variables: [{ key: 'body', type: 'textarea' }], maxImages: 9 }];
  api.state.accounts = [{ id: 'acc1', name: '测试账号' }];
  return { ...api, $, document, NearTime: context.NearTime, apiCalls, dialogCalls };
}
function row(id) {
  return { id, status: 'ready', title: '', images: [], selectedImages: [], credit: '作者', variables: {}, manualTitle: false, scheduledAt: '', collision: false };
}

test('已有结果后开始编排会追加到末尾且不改旧行', async () => {
  const p = await page();
  const old = row('old');
  old.title = '旧标题';
  old.scheduledAt = new Date(2026, 9, 12, 10, 0, 0, 0).toISOString();
  const oldSnapshot = { title: old.title, scheduledAt: old.scheduledAt };
  p.state.rows = [old];
  p.state.links.valid = ['https://x.com/example/status/1'];

  await p.startParsing();

  assert.equal(p.state.rows.length, 2);
  assert.equal(old.title, oldSnapshot.title);
  assert.equal(old.scheduledAt, oldSnapshot.scheduledAt);
  const added = p.state.rows.find(item => item.id !== old.id);
  assert.equal(added.status, 'ready');
  assert.ok(new Date(added.scheduledAt).getTime() > new Date(old.scheduledAt).getTime());
  assert.equal(p.state.parsingIds.length, 0);
});

test('replan(ids) 只排指定新行，旧行与其他未排期行均不动', async () => {
  const p = await page();
  const old = row('old'), added = row('new'), untouched = row('untouched');
  old.title = '保留旧标题';
  old.scheduledAt = new Date(2026, 9, 12, 12, 0, 0, 0).toISOString();
  untouched.title = '不要处理';
  const oldTime = old.scheduledAt;
  p.state.rows = [old, added, untouched];

  p.replan(['new']);

  assert.equal(old.title, '保留旧标题');
  assert.equal(old.scheduledAt, oldTime);
  assert.equal(untouched.title, '不要处理');
  assert.equal(untouched.scheduledAt, '');
  assert.ok(new Date(added.scheduledAt).getTime() > new Date(oldTime).getTime());
});

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

test('showConfirm 无临近项时红块隐藏', async () => {
  const p = await page();
  const a = row('a'); a.scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 小时后
  p.state.rows = [a];
  p.showConfirm();
  assert.equal(p.$('#confirm-warning').style.display, 'none');
  assert.match(p.$('#confirm-body').innerHTML, /将向/);
});

test('showConfirm 有1条 30 分钟内时红块显示数量与最早时间', async () => {
  const p = await page();
  const now = Date.now();
  const nearTime = new Date(now + 15 * 60 * 1000).toISOString(); // 15 分钟后
  const farTime = new Date(now + 60 * 60 * 1000).toISOString(); // 1 小时后
  const a = row('a'); a.scheduledAt = nearTime;
  const b = row('b'); b.scheduledAt = farTime;
  p.state.rows = [a, b];
  p.showConfirm();
  assert.notEqual(p.$('#confirm-warning').style.display, 'none');
  const warnText = p.$('#confirm-warning-text').textContent;
  assert.match(warnText, /1 条动态将在 30 分钟内发布/);
  assert.match(warnText, /最早计划时间/);
  assert.match(warnText, /已过期的任务将按立即发布处理/);
});

test('confirmEnqueue 成功时先解除 loading 再关闭确认弹窗', async () => {
  const p = await page();
  const a = row('a');
  a.scheduledAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  p.state.rows = [a];
  p.showConfirm();
  p.dialogCalls.length = 0;

  await p.confirmEnqueue();

  const loadingOffIndex = p.dialogCalls.indexOf('setLoading(false)');
  const closeIndex = p.dialogCalls.indexOf('close');
  assert.ok(loadingOffIndex >= 0);
  assert.ok(closeIndex > loadingOffIndex);
  assert.equal(p.dialogCalls.includes('close-while-loading'), false);
});
