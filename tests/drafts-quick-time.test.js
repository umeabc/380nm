'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function draftPage(now, initialValue = '') {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  }
  const elements = new Map(), timers = new Map();
  const messages = [], calls = [], events = [], formattedDates = [];
  let nextTimer = 0, ready;
  function element() {
    const listeners = new Map();
    return {
      value: '', textContent: '', innerHTML: '', classList: { toggle() {} },
      querySelector: () => null, querySelectorAll: () => [],
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      emit(type, target) { for (const listener of listeners.get(type) || []) listener({ target }); }
    };
  }
  const $ = key => {
    if (!elements.has(key)) elements.set(key, element());
    return elements.get(key);
  };
  const fields = new Map();
  const card = { dataset: { draft: 'd1' }, querySelector(selector) {
    if (selector === '[data-edit="scheduledAt"]') return input;
    if (!fields.has(selector)) fields.set(selector, element());
    return fields.get(selector);
  } };
  const input = {
    value: initialValue, dataset: { edit: 'scheduledAt' },
    closest: selector => selector === '[data-edit]' ? input : selector === '[data-draft]' ? card : null,
    dispatchEvent(event) {
      events.push(event);
      if (event.bubbles) $('#list').emit(event.type, input);
      return true;
    }
  };
  const select = {
    value: '',
    closest: selector => selector === '[data-quick-time]' ? select : selector === '[data-draft]' ? card : null
  };
  $('#list').querySelector = () => card;
  $('#list').querySelectorAll = () => [card];
  const context = {
    window: {}, document: {}, Event, Date: FixedDate,
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    TextRender: require('../public/js/text-render'), Staff: require('../public/js/staff'),
    App: {
      $, $$: () => [], esc: String,
      toast: message => messages.push(message),
      toLocalInput(date) {
        formattedDates.push(new Date(date.getTime()));
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
      },
      async api(method, url, patch) {
        if (method === 'PATCH') {
          calls.push({ method, url, patch: { ...patch } });
          return { draft: { id: 'd1', ...patch, text: 'Saved', incomplete: false } };
        }
        return { drafts: [{ id: 'd1', variables: {} }], templates: [], accounts: [] };
      },
      async boot(options) { ready = options.ready; }
    }
  };
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/drafts.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, editor, inlineFields }; })();');
  await vm.runInNewContext(source, context);
  await ready();
  return {
    ...context.window.testing, input, select, messages, calls, events, formattedDates, timers, fields,
    choose(value = '10') { select.value = value; $('#list').emit('change', select); },
    async flushDebounce() {
      assert.equal(timers.size, 1);
      const [id, timer] = timers.entries().next().value;
      assert.equal(timer.delay, 600);
      timers.delete(id);
      await timer.callback();
    }
  };
}

function assertTime(page, expected) {
  const actual = new Date(page.input.value);
  assert.equal(actual.getTime(), expected.getTime());
  assert.equal(actual.getSeconds(), 0);
  const formatted = page.formattedDates.at(-1);
  assert.equal(formatted.getTime(), expected.getTime());
  assert.equal(formatted.getMilliseconds(), 0);
  assert.equal(page.select.value, '');
}

test('快捷时间选项 value="10"：无日期且未到整点时设为今天 10:00，秒归零', async () => {
  const page = await draftPage(new Date(2030, 5, 15, 9, 23, 47, 123));
  assert.match(page.inlineFields({ id: 'd1' }), /<option value="10">10:00<\/option>/);
  page.choose('10');
  assertTime(page, new Date(2030, 5, 15, 10));
  assert.deepEqual(page.messages, []);
});

test('快捷时间无日期且今天整点已过时设为明天 10:00 并 toast', async () => {
  const page = await draftPage(new Date(2030, 5, 15, 10, 0, 1));
  page.choose('10');
  assertTime(page, new Date(2030, 5, 16, 10));
  assert.deepEqual(page.messages, ['已顺延到明天 10:00']);
});

test('快捷时间保留已有的未来日期，仅将时分秒改为 10:00:00', async () => {
  const page = await draftPage(new Date(2030, 5, 15, 12), '2030-06-20T18:37:42');
  page.choose('10');
  assertTime(page, new Date(2030, 5, 20, 10));
  assert.deepEqual(page.messages, []);
});

test('快捷时间已有日期算出过去时间时顺延到明天同一整点并 toast', async () => {
  const page = await draftPage(new Date(2030, 11, 31, 12, 34, 56), '2030-12-20T18:37');
  page.choose('10');
  assertTime(page, new Date(2031, 0, 1, 10));
  assert.deepEqual(page.messages, ['已顺延到明天 10:00']);
});

test('快捷时间派发冒泡 input 并复用既有 600ms 防抖 PATCH 保存链路', async () => {
  const page = await draftPage(new Date(2030, 5, 15, 9));
  page.choose('10');
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].type, 'input');
  assert.equal(page.events[0].bubbles, true);
  const firstTimer = page.editor('d1').timer;
  page.choose('11');
  assert.equal(page.events.length, 2);
  assert.equal(page.timers.has(firstTimer), false);
  const scheduledAt = new Date(2030, 5, 15, 11).toISOString();
  assert.equal(page.editor('d1').pending.scheduledAt, scheduledAt);
  assert.equal(page.state.drafts[0].scheduledAt, scheduledAt);
  assert.equal(page.fields.get('[data-status]').textContent, '待保存');
  assert.equal(page.calls.length, 0);
  await page.flushDebounce();
  assert.deepEqual(page.calls, [{ method: 'PATCH', url: '/api/drafts/d1', patch: { scheduledAt } }]);
  assert.equal(Object.keys(page.editor('d1').pending).length, 0);
  assert.equal(page.fields.get('[data-status]').textContent, '已保存');
});
