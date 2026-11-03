'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 最小 DOM 桩记录真实事件处理器，不给生产代码新增测试入口。
function element() {
  return { style: {}, dataset: {}, attributes: {}, innerHTML: '', textContent: '', value: '', listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    focus() { this.focused = true; }, select() {}, remove() { this.removed = true; },
    contains(target) { return target === this; }, setAttribute(name, value) { this.attributes[name] = value; },
    getBoundingClientRect() { return { left: 20, bottom: 60 }; }, offsetHeight: 100 };
}
async function page(options = {}) {
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
    if (options.api) { const handled = await options.api(method, url, body); if (handled !== undefined) return handled; }
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
      images: options.parseImages || []
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
  const context = vm.createContext({ console, Date: options.Date || Date, URL, Map, Set, document, fetch,
    AbortController, TextDecoder, TextEncoder, setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    crypto: { randomUUID: () => `uuid-${++uuidCounter}` },
    window: { innerWidth: 1000, innerHeight: 800 },
    App: { $, $$: selector => selector === '[data-b-person]' ? (options.selects || []) : [], api: apiFn, icon: () => '<svg></svg>', imageSrc: image => image?.url || '', esc: s => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
      toLocalInput: date => localInput(date), boot: async () => {}, toast() {}, debounce: fn => fn },
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
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { renderRowEditor, state, saveDraft, debouncedSave, renderPeopleFields, makeCredit, templatePeople, peopleVariables, startParsing, finalizeParsing, replan, renderProgress, renderRow, editTitle, buildJobItem, timeOptions, changeTime, renderTable, bindRowEvents, openTimePopover, closeTimePopover, showConfirm, confirmEnqueue, abortParsing }; })();');
  context.TextRender = require('../public/js/text-render');
  context.Staff = require('../public/js/staff');
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

function localInput(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

async function timePage(now = new Date(2030, 5, 15, 9, 30)) {
  const clock = { now: now.getTime() }, timers = new Map();
  let timerId = 0;
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const p = await page({ Date: FixedDate,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  Object.assign(p.state.config, { date: '2030-06-15', start: '10:00', end: '14:00' });
  const a = { ...row('custom'), title: '保留原标题', scheduledAt: new Date(2030, 5, 15, 12, 34, 56).toISOString() };
  p.state.rows = [a];
  function openCustom() {
    const panel = element(), input = element(), error = element(), form = element(), cancel = element();
    const children = new Map([['input', input], ['.batch-time-error', error], ['form', form], ['[data-cancel-time]', cancel], ['button', element()]]);
    panel.querySelector = selector => children.get(selector) || null;
    panel.contains = target => target === panel || [...children.values()].includes(target);
    p.document.createElement = () => panel;
    p.openTimePopover(a, element());
    assert.match(panel.innerHTML, /data-custom-time>自定义…/);
    assert.ok(panel.innerHTML.indexOf('data-custom-time') > panel.innerHTML.lastIndexOf('data-slot='));
    const target = { closest: selector => selector === '[data-custom-time]' ? target : null };
    let stopped = false;
    panel.listeners.click({ target, stopPropagation() { stopped = true; } });
    // 切换表单会移除原按钮，若继续冒泡，外部点击监听将把浮层错误关闭。
    if (!stopped) p.document.listeners.click({ target });
    assert.equal(panel.removed, undefined);
    return { panel, input, error, cancel, submit(value) {
      input.value = value;
      let prevented = false;
      form.listeners.submit({ preventDefault() { prevented = true; } });
      assert.equal(prevented, true);
    } };
  }
  return { ...p, a, clock, timers, openCustom };
}

test('时间徽章仅可编辑且有排期的行支持双击，时钟单击仍显示候选', async () => {
  const p = await timePage();
  for (const status of ['ready', 'enqueue_failed', 'queued', 'parsing', 'parse_failed']) {
    for (const hasTime of [true, false]) {
      const a = { ...p.a, status, scheduledAt: hasTime ? p.a.scheduledAt : '' };
      p.state.rows = [a];
      const badge = element(), clockButton = element(), tr = element(), box = element();
      const editable = ['ready', 'enqueue_failed'].includes(status) && hasTime;
      tr.dataset.rowId = a.id;
      tr.querySelector = selector => selector === '.batch-time-badge' ? badge : selector === '.batch-time-edit' ? (editable ? clockButton : null) : element();
      box.querySelectorAll = selector => selector === '[data-row-id]' ? [tr] : [];
      p.bindRowEvents(box);
      assert.equal(typeof badge.listeners.dblclick === 'function', editable);
      assert.equal(p.renderRow(a, 0).includes('title="双击或点击右侧时钟修改计划时间"'), editable);
      if (editable) {
        badge.listeners.dblclick({ currentTarget: badge });
        const first = p.document.panel;
        assert.match(first.innerHTML, /data-slot="0"/);
        clockButton.listeners.click({ currentTarget: clockButton });
        assert.equal(first.removed, true);
        assert.match(p.document.panel.innerHTML, /data-slot="0"/);
        assert.doesNotMatch(p.document.panel.innerHTML, /datetime-local/);
      }
    }
  }
});

test('自定义表单使用本地分钟值，输入获焦且切换不会被外部点击监听关闭', async () => {
  const p = await timePage();
  const { panel, input } = p.openCustom();
  assert.match(panel.innerHTML, /type="datetime-local" step="60"/);
  assert.equal(input.value, '2030-06-15T12:34');
  assert.equal(input.min, '2030-06-15T10:00');
  assert.equal(input.focused, true);
  p.document.listeners.click({ target: input });
  assert.equal(panel.removed, undefined);
});

for (const manualTitle of [false, true]) {
  test(`自定义时间保存 ISO 排期、撞点及草稿且保留标题（manualTitle=${manualTitle}）`, async () => {
    const p = await timePage();
    p.a.manualTitle = manualTitle;
    // 不限制候选网格，不要求晚于原排期或其他行；只修改这一行。
    const scheduledAt = new Date(2030, 5, 15, 11, 17).toISOString();
    const other = { ...row('other'), scheduledAt, title: '另一行' };
    p.state.rows.push(other);
    const form = p.openCustom();
    form.submit('2030-06-15T11:17');
    assert.equal(p.a.scheduledAt, scheduledAt);
    assert.equal(p.a.manualTime, scheduledAt);
    assert.equal(p.a.title, '保留原标题');
    assert.equal(p.a.manualTitle, manualTitle);
    assert.equal(other.scheduledAt, scheduledAt);
    assert.equal(other.title, '另一行');
    assert.equal(p.a.collision, true);
    assert.equal(other.collision, true);
    assert.equal(form.panel.removed, true);
    assert.equal(p.state.saveDirty, true);
    const [id, timer] = [...p.timers].find(([, task]) => task.delay === 500);
    p.timers.delete(id);
    await timer.callback();
    const saves = p.apiCalls.filter(call => call.method === 'PUT');
    assert.equal(saves.length, 1);
    const saved = saves[0].body.rows.find(item => item.id === p.a.id);
    assert.equal(saved.scheduledAt, scheduledAt);
    assert.equal(saved.manualTime, scheduledAt);
    assert.equal(saved.title, '保留原标题');
    assert.equal(saved.manualTitle, manualTitle);
  });
}

test('自定义无效日期、过去时间和原排期下界之前的时间保留浮层并显示红框错误', async () => {
  const p = await timePage(new Date(2030, 5, 15, 9, 30, 10));
  // 原行配置优先于已改变的全局时间窗。
  p.a.config = { start: '10:00' };
  p.state.config.start = '08:00';
  const before = p.a.scheduledAt;
  const form = p.openCustom();
  for (const [value, message] of [
    ['', '请输入有效的日期和时间'], ['not-a-date', '请输入有效的日期和时间'],
    ['2030-02-30T12:00', '请输入有效的日期和时间'],
    ['2030-06-15T09:29', '不能早于当前时间'], ['2030-06-15T09:30', '不能早于当前时间'],
    ['2030-06-15T09:59', '不能早于原排期起始时间（2030-06-15 10:00）']
  ]) {
    form.submit(value);
    assert.equal(form.error.textContent, message);
    assert.equal(form.input.attributes['aria-invalid'], 'true');
    assert.equal(form.panel.removed, undefined);
    assert.equal(p.a.scheduledAt, before);
    assert.equal(p.a.manualTime, undefined);
    assert.equal(p.a.title, '保留原标题');
    assert.equal(p.state.saveDirty, false);
    assert.equal(p.timers.size, 0);
    form.input.listeners.input();
    assert.equal(form.error.textContent, '');
    assert.equal(form.input.attributes['aria-invalid'], 'false');
  }
  form.submit('2030-06-15T10:00');
  assert.equal(p.a.scheduledAt, new Date(2030, 5, 15, 10).toISOString());
});

test('自定义按确认时的当前时间校验，等于当前整分可用，min 向上取整', async () => {
  const p = await timePage(new Date(2030, 5, 15, 11, 20, 10));
  const form = p.openCustom();
  assert.equal(form.input.min, '2030-06-15T11:21');
  p.clock.now = new Date(2030, 5, 15, 12, 0).getTime();
  form.submit('2030-06-15T11:59');
  assert.equal(form.error.textContent, '不能早于当前时间');
  form.submit('2030-06-15T12:00');
  assert.equal(p.a.scheduledAt, new Date(p.clock.now).toISOString());
  assert.equal(form.panel.removed, true);
});

test('自定义允许跨日及时间窗外时间，候选改时仍更新自动标题', async () => {
  const p = await timePage();
  p.openCustom().submit('2030-06-16T16:23');
  assert.equal(p.a.scheduledAt, new Date(2030, 5, 16, 16, 23).toISOString());
  assert.equal(p.a.title, '保留原标题');
  assert.equal(p.a.manualTitle, false);
  const slot = p.timeOptions(p.a)[0];
  p.changeTime(p.a, slot);
  assert.equal(p.a.title, slot.title);
});

test('自定义取消、Escape 和外部点击均关闭浮层且不修改或保存', async () => {
  const p = await timePage();
  const before = p.a.scheduledAt;
  for (const close of [form => form.cancel.listeners.click(), () => p.document.listeners.keydown({ key: 'Escape' }), () => p.document.listeners.click({ target: element() })]) {
    const form = p.openCustom();
    form.input.value = '2030-06-16T13:00';
    close(form);
    assert.equal(form.panel.removed, true);
    assert.equal(p.a.scheduledAt, before);
    assert.equal(p.a.manualTime, undefined);
    assert.equal(p.state.saveDirty, false);
    assert.equal(p.timers.size, 0);
  }
});

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

test('saveDraft 在请求 in-flight 时不丢弃而是排队补发最新状态', async () => {
  const savedBodies = [];
  let gate = null;
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const document = element();
  document.body = { appendChild(el) { document.panel = el; } };
  document.createElement = () => { const el = element(); el.querySelector = () => element(); return el; };
  let putCount = 0;
  const apiFn = (method, url, body) => {
    if (method === 'GET' && url === '/api/batch-draft') return Promise.resolve({ revision: 0, rows: [], config: {} });
    if (method === 'PUT' && url === '/api/batch-draft') {
      putCount++;
      savedBodies.push(body);
      return putCount === 1 && gate ? gate.promise : Promise.resolve({ revision: (body.revision || 0) + 1 });
    }
    return Promise.reject(new Error('unexpected: ' + method + ' ' + url));
  };
  const context = vm.createContext({ console, Date, Map, Set, document,
    fetch: async () => { throw new Error('no fetch'); },
    AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'uuid' },
    window: { innerWidth: 1000, innerHeight: 800 },
    App: { $, $$: () => [], api: apiFn, icon: () => '<svg></svg>', imageSrc: () => '', esc: s => String(s ?? ''),
      boot: async () => {}, toast() {}, debounce: fn => fn },
    ConfirmDialog: { create: () => ({ open() {}, close() { return true; }, setLoading() {} }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/near-time.js'), 'utf8'), context);
  context.NearTime = context.window.NearTime;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/schedule.js'), 'utf8'), context);
  context.BatchSchedule = context.window.BatchSchedule;
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/batch.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { renderRowEditor, state, saveDraft, draftBody }; })();');
  context.TextRender = require('../public/js/text-render');
  context.Staff = require('../public/js/staff');
  await vm.runInContext(source, context);
  const api2 = context.window.testing;

  // 第一次保存挂起（等待 gate），期间 rows 变化后再保存：不能被丢弃。
  let resolveFirst;
  gate = { promise: new Promise(r => { resolveFirst = r; }) };
  const first = api2.saveDraft();
  const a = row('a'); a.title = '第一次';
  api2.state.rows = [a];
  await Promise.resolve();
  const second = api2.saveDraft(); // in-flight → 应只置 saveQueued
  assert.equal(api2.state.saveQueued, true);
  a.title = '补发后的标题';
  api2.state.rows = [a];
  api2.saveDraft(); // 再次排队（仍应合并为一次补发）
  resolveFirst({ revision: 1 });
  gate = null;
  await first; await second;
  assert.equal(api2.state.savePending, false);
  assert.equal(api2.state.saveQueued, false);
  assert.equal(api2.state.saveDirty, false);
  // 补发那次 PUT 带上的是最新标题（通过 revision 递增确认补发确实发生）
  assert.equal(api2.state.revision, 2);
  assert.equal(savedBodies.length, 2);
  assert.equal(savedBodies[1].rows[0].title, '补发后的标题');
});

test('恢复草稿：有 images 的 parsing 行恢复为 ready，空行才标 parse_failed', async () => {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const document = element();
  document.body = { appendChild(el) { document.panel = el; } };
  document.createElement = () => { const el = element(); el.querySelector = () => element(); return el; };
  const draft = {
    revision: 0,
    rows: [
      { id: 'r1', status: 'parsing', images: [{ url: 'https://img/1' }], scheduledAt: '', title: '' },
      { id: 'r2', status: 'parsing', images: [], scheduledAt: '2026-10-12T10:00:00.000Z', title: '' },
      { id: 'r3', status: 'pending', images: [], scheduledAt: '', title: '有标题' },
      { id: 'r4', status: 'pending', images: [], scheduledAt: '', title: '' },
      { id: 'r5', status: 'ready', images: [], scheduledAt: '', title: '' }
    ],
    config: {}
  };
  const apiFn = async (method, url, body) => {
    if (method === 'GET' && url === '/api/batch-draft') return draft;
    if (method === 'PUT' && url === '/api/batch-draft') return { revision: (body.revision || 0) + 1 };
    throw new Error('unexpected: ' + method + ' ' + url);
  };
  const context = vm.createContext({ console, Date, Map, Set, document,
    fetch: async () => { throw new Error('no fetch'); },
    AbortController, TextDecoder, TextEncoder, setTimeout, clearTimeout,
    crypto: { randomUUID: () => 'uuid' },
    window: { innerWidth: 1000, innerHeight: 800 },
    App: { $, $$: () => [], api: apiFn, icon: () => '<svg></svg>', imageSrc: () => '', esc: s => String(s ?? ''),
      boot: async () => {}, toast() {}, debounce: fn => fn },
    ConfirmDialog: { create: () => ({ open() {}, close() { return true; }, setLoading() {} }) } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/near-time.js'), 'utf8'), context);
  context.NearTime = context.window.NearTime;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/schedule.js'), 'utf8'), context);
  context.BatchSchedule = context.window.BatchSchedule;
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/batch.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, restoreDraft }; })();');
  context.TextRender = require('../public/js/text-render');
  context.Staff = require('../public/js/staff');
  await vm.runInContext(source, context);
  const api2 = context.window.testing;

  await api2.restoreDraft();
  const byId = Object.fromEntries(api2.state.rows.map(r => [r.id, r]));
  assert.equal(byId.r1.status, 'ready'); // 有 images → ready
  assert.equal(byId.r1.error, null);
  assert.equal(byId.r2.status, 'ready'); // 有 scheduledAt → ready
  assert.equal(byId.r3.status, 'ready'); // 有 title → ready
  assert.equal(byId.r4.status, 'parse_failed'); // 全空 → 编排中断
  assert.equal(byId.r4.error, '编排中断');
  assert.equal(byId.r5.status, 'ready'); // 原 ready 不动
});


test('batch signatures replace source and person placeholders without treating body as credit', async () => {
  const p = await page();
  const tpl = { category: 'batch', content: '{{credit}}\n{{body}}', signatureFormat: '作者：{{author}} / @{{handle}} / {{sourceUrl}} / {{translator}}' };
  p.state.libAccounts = [{ id: 'p1', name: '译者', handle: 't', status: '在岗' }];
  p.state.config.staff = ['p1'];
  assert.equal(p.templatePeople(tpl).join(','), 'translator');
  const variables = p.peopleVariables(tpl);
  assert.equal(variables.translator, '@t');
  assert.equal(p.makeCredit({ author: '画师', handle: '@artist' }, tpl, { ...variables, sourceUrl: 'https://x.com/artist/status/1' }), '作者：画师 / @artist / https://x.com/artist/status/1 / @t');
});


test('person pool binds real add/remove handlers and saves ordered IDs', async () => {
  const add = element(), remove = element(); remove.dataset.staffRemove = '0';
  const p = await page();
  p.$('#batch-people').querySelector = () => add;
  p.$('#batch-people').querySelectorAll = () => [remove];
  p.state.libAccounts = [{ id: 'person1', name: '甲', handle: 'one' }, { id: 'person2', name: '乙', handle: 'two' }];
  p.renderPeopleFields({ content: '{{translator}} {{typesetter}}' });
  add.value = 'person1'; add.listeners.change();
  add.value = 'person2'; add.listeners.change();
  assert.equal(p.state.config.staff[0], 'person1');
  assert.equal(p.state.config.staff[1], 'person2');
  remove.listeners.click();
  assert.equal(p.state.config.staff.join(','), 'person2');
  await p.saveDraft();
  assert.equal(p.apiCalls.find(call => call.method === 'PUT').body.config.staff.join(','), 'person2');
});

test('maxImages zero keeps parsed artwork in library but selects no publish images', async () => {
  const p = await page({ parseImages: [{ key: 'image1', url: '/image1' }] });
  p.state.templates[0].maxImages = 0;
  p.state.links.valid = ['https://x.com/artist/status/1'];
  await p.startParsing();
  assert.equal(p.state.rows[0].images.length, 1);
  assert.equal(p.state.rows[0].selectedImages.length, 0);
});

test('immediate confirmation flushes edits and waits for an in-flight save before enqueue', async () => {
  let release;
  let puts = 0;
  let storedBody;
  const p = await page({ api: async (method, url, body) => {
    if (method === 'PUT') {
      puts++;
      if (puts === 1) await new Promise(resolve => { release = resolve; });
      storedBody = body.rows[0].body;
      return { revision: puts };
    }
  } });
  const item = row('fast'); item.body = 'old'; p.state.rows = [item];
  const ongoing = p.saveDraft();
  item.body = 'latest edit'; p.debouncedSave(); p.showConfirm();
  const confirming = p.confirmEnqueue();
  await Promise.resolve();
  assert.equal(p.apiCalls.some(call => call.method === 'POST'), false);
  release(); await ongoing; await confirming;
  assert.equal(storedBody, 'latest edit');
  assert.equal(puts, 2);
  const post = p.apiCalls.find(call => call.method === 'POST');
  assert.equal(post.body.revision, 2);
});

test('failed flush blocks enqueue and leaves rows available to retry', async () => {
  const p = await page({ api: async method => { if (method === 'PUT') throw new Error('offline'); } });
  p.state.rows = [row('unsaved')]; p.showConfirm(); await p.confirmEnqueue();
  assert.equal(p.apiCalls.some(call => call.method === 'POST'), false);
  assert.equal(p.state.rows.length, 1);
  assert.equal(p.state.enqueueInFlight, false);
});


test('pasting links then immediately starting parses current textarea before debounce fires', async () => {
  const p = await page();
  p.$('#b-links').value = 'https://x.com/artist/status/123\nhttps://www.pixiv.net/artworks/456';
  assert.equal(p.state.links.valid.length, 0);
  await p.startParsing();
  assert.equal(p.state.rows.length, 2);
  assert.equal(p.state.rows.every(row => row.status === 'ready'), true);
  assert.equal(p.state.rows.map(row => row.url).join(','), 'https://x.com/artist/status/123,https://www.pixiv.net/artworks/456');
});

test('batch original author survives buildJobItem and refreshes stale signature credit', async () => {
  const p = await page();
  const tpl = { id: 'tpl', category: 'batch', content: '{{credit}}\n{{body}}/{{OrigAuthor}}', signatureFormat: 'By {{origAuthor}} @{{handle}}', variables: [{ key: 'body', type: 'textarea' }] };
  p.state.templates = [tpl];
  const item = p.buildJobItem({ ...row('orig'), variables: { origAuthor: 'New', handle: 'artist' }, credit: 'By Old', body: 'Body' });
  assert.equal(require('../src/render').renderBody(tpl, item.variables), 'By New @artist\nBody/New');
  assert.equal(p.makeCredit({ author: 'Artist', handle: 'artist' }, tpl, { origAuthor: 'Edited' }), 'By Edited @artist');
});

test('batch editor warns when author input cannot affect the selected template', async () => {
  const p = await page();
  p.state.templates = [{ id: 'tpl', content: '{{credit}}', variables: [] }];
  const html = p.renderRowEditor({ ...row('warning'), variables: { origAuthor: 'Artist' } });
  assert.ok(html.includes(require('../public/js/text-render').hint(p.state.templates[0])));
  assert.match(html, /data-field="origAuthor" value="Artist"/);
});
