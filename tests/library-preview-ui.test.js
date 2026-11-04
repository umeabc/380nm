'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

function element() {
  const classes = new Set();
  return { style: {}, dataset: {}, innerHTML: '', textContent: '', value: '', listeners: {},
    classList: { add: s => classes.add(s), remove: s => classes.delete(s), contains: s => classes.has(s),
      toggle(s, value = !classes.has(s)) { if (value) classes.add(s); else classes.delete(s); } },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    removeEventListener(type) { delete this.listeners[type]; },
    getBoundingClientRect() { return { left: 10, top: 10, right: 50, bottom: 50, width: 40, height: 40 }; },
    appendChild() {}, remove() {}, querySelectorAll: () => [] };
}

async function fixture(page = 'library', options = {}) {
  const nodes = new Map(), calls = [], intervals = [], cells = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const images = options.images || [
    { key: 'one', url: '/uploads/one', name: '第一张', folderId: 'f' },
    { key: 'two', url: 'https://images.example/two', name: '第二张', folderId: 'f' },
    { key: 'other', url: '/uploads/other', name: '别的文件夹', folderId: 'other' }
  ];
  for (const image of images) cells.push(Object.assign(element(), { dataset: { lib: image.key } }));
  const document = Object.assign(element(), {
    querySelector: selector => selector.startsWith('#lib-grid [data-lib=')
      ? cells.find(cell => selector.includes('"' + cell.dataset.lib + '"')) : node(selector),
    querySelectorAll: selector => selector === '#lib-grid .cell' ? cells : [],
    getElementById: id => nodes.get('#' + id),
    createElement: element,
    body: Object.assign(element(), { appendChild(el) { if (el.id) nodes.set('#' + el.id, el); } })
  });
  for (const id of ['pv-img', 'pv-imgwrap', 'pv-title', 'pv-thumbs']) node('#' + id);
  let jobs = options.jobs || [];
  const context = vm.createContext({ window: { innerWidth: 1000, innerHeight: 800 }, document,
    location: { pathname: '/' + page, search: '' }, localStorage: { getItem: () => null },
    CSS: { escape: String }, setTimeout() {}, clearTimeout() {},
    setInterval(fn, ms) { intervals.push({ fn, ms }); return intervals.length; },
    confirm: () => true,
    fetch: async (url, request) => {
      const body = request.body ? JSON.parse(request.body) : undefined;
      calls.push({ url, method: request.method, body });
      let data;
      if (url === '/api/auth/me') data = { user: { role: 'user', username: '测试' } };
      else if (url === '/api/jobs') data = { jobs };
      else if (url === '/api/images') data = { images };
      else if (url === '/api/folders') data = { folders: [{ id: 'f', name: '文件夹' }] };
      else if (url === '/api/storage/usage') data = { usage: null };
      else if (url === '/api/images/move') data = { moved: body.keys.length };
      else if (url === '/api/images/delete') data = { ok: true };
      else throw new Error('unexpected request: ' + url);
      return { ok: true, status: 200, json: async () => data };
    }
  });
  vm.runInContext(read('public/js/common.js'), context);
  const app = context.App = context.window.App;
  const counts = { pub: 0, pend: 0 };
  for (const [key, name] of [['pub', 'publishedImageMap'], ['pend', 'pendingImageMap']]) {
    const original = app[name];
    app[name] = (...args) => { counts[key]++; return original(...args); };
  }
  let ready;
  const boot = app.boot;
  app.boot = cfg => (ready = boot(cfg));
  let source = read('public/js/pages/' + page + '.js');
  if (page === 'library') {
    const withHook = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, renderLibrary, viewImages }; })();');
    assert.notEqual(withHook, source, 'library test hook must be inserted');
    source = withHook;
  }
  await vm.runInContext(source, context);
  await ready;
  return { app, node, document, calls, cells, counts, intervals, images, ...context.window.testing,
    setJobs(value) { jobs = value; } };
}

function event(cell, control = '', detail = 1) {
  return { button: 0, detail, clientX: 20, clientY: 20, prevented: 0, stopped: 0,
    target: { closest(selector) {
      if (control && selector.split(',').map(s => s.trim()).includes(control)) return cell;
      return selector === '[data-lib]' ? cell : null;
    } },
    preventDefault() { this.prevented++; }, stopPropagation() { this.stopped++; } };
}

test('图库双击从当前文件夹/发布筛选内被点图片开始，使用原图并保持选择', async () => {
  const p = await fixture('library', { jobs: [{ status: 'pending', images: [{ key: 'one' }, { key: 'two' }] }] });
  p.state.libFolder = 'f'; p.state.pubFilter = 'pending'; p.renderLibrary();
  assert.match(p.node('#lib-grid').innerHTML, /title="双击查看大图"/);
  const grid = p.node('#lib-grid');
  for (const initiallySelected of [false, true]) {
    p.state.selectedKeys.clear();
    if (initiallySelected) p.state.selectedKeys.add('two');
    // 浏览器先派发两组鼠标/单击事件，再派发 dblclick。
    for (const detail of [1, 2]) {
      grid.listeners.mousedown(event(p.cells[1], '', detail));
      p.document.listeners.mouseup();
      grid.listeners.click(event(p.cells[1], '', detail));
    }
    const e = event(p.cells[1], '', 2);
    grid.listeners.dblclick(e);
    assert.equal(e.prevented, 1); assert.equal(e.stopped, 1);
    assert.equal(p.state.selectedKeys.has('two'), initiallySelected);
    assert.equal(p.node('#pv-img').src, p.images[1].url);
    assert.equal(p.node('#pv-imgwrap').href, p.images[1].url);
    assert.equal(p.node('#pv-title').textContent, '配图 2 / 2 · 第二张');
    p.document.listeners.keydown({ key: 'ArrowRight' });
    assert.equal(p.node('#pv-img').src, p.images[0].url);
    p.document.listeners.keydown({ key: 'ArrowLeft' });
    assert.equal(p.node('#pv-img').src, p.images[1].url);
  }
  p.document.listeners.keydown({ key: 'Escape' });
  assert.equal(p.node('#pv-modal').style.display, 'none');
});

test('双击选择框/删除/旧移动子元素不预览，框选完成后不误切选择或打开预览', async () => {
  const p = await fixture(); const grid = p.node('#lib-grid');
  for (const control of ['.selbox', '.del', '.mv']) grid.listeners.dblclick(event(p.cells[0], control, 2));
  assert.equal(p.document.getElementById('pv-modal'), undefined);
  grid.listeners.mousedown(event(p.cells[0]));
  p.document.listeners.mousemove({ clientX: 60, clientY: 60 });
  grid.listeners.dblclick(event(p.cells[0], '', 2));
  assert.equal(p.document.getElementById('pv-modal'), undefined);
  p.document.listeners.mouseup();
  grid.listeners.click(event(p.cells[0]));
  grid.listeners.dblclick(event(p.cells[0], '', 2));
  assert.equal(p.document.getElementById('pv-modal'), undefined);
  assert.equal(p.state.selectedKeys.has('one'), true);
  const checkbox = { dataset: { check: 'one' } };
  grid.listeners.click(event(checkbox, '[data-check]'));
  assert.equal(p.state.selectedKeys.has('one'), false);
  const deletion = { dataset: { libdel: 'two' } };
  await grid.listeners.click(event(deletion, '[data-libdel]'));
  assert.equal(p.calls.filter(c => c.url === '/api/images/delete').length, 1);
  grid.listeners.mousedown(event(p.cells[0])); p.document.listeners.mouseup();
  grid.listeners.dblclick(event(p.cells[0], '', 2));
  assert.equal(p.node('#pv-img').src, p.images[0].url);
});

test('框选后的新单击/双击发布角标仍可选择并打开预览', async () => {
  const p = await fixture('library', { jobs: [{ status: 'published', images: [{ key: 'one' }] }] });
  const grid = p.node('#lib-grid');
  grid.listeners.mousedown(event(p.cells[0]));
  p.document.listeners.mousemove({ clientX: 60, clientY: 60 });
  p.document.listeners.mouseup();
  assert.equal(p.state.selectedKeys.has('one'), true);
  for (const detail of [1, 2]) {
    grid.listeners.mousedown(event(p.cells[0], '.pub-badge', detail));
    grid.listeners.click(event(p.cells[0], '.pub-badge', detail));
    assert.equal(p.state.selectedKeys.has('one'), detail === 2);
  }
  grid.listeners.dblclick(event(p.cells[0], '.pub-badge', 2));
  assert.equal(p.node('#pv-img').src, p.images[0].url);
});

test('图库不渲染单图移动按钮，批量移动菜单和服务端请求保留', async () => {
  const p = await fixture();
  assert.doesNotMatch(p.node('#lib-grid').innerHTML, /class="mv"|data-libmove/);
  assert.match(read('public/library.html'), /id="btn-batch-move"/);
  assert.match(read('public/library.html'), /id="move-menu"/);
  p.state.selectedKeys.add('one'); p.state.selectedKeys.add('two'); p.renderLibrary();
  const button = p.node('#btn-batch-move');
  assert.equal(button.disabled, false);
  button.listeners.click({ currentTarget: button });
  assert.equal(p.state.moveKeys.join(','), 'one,two');
  assert.match(p.node('#move-menu').innerHTML, /移动 2 张到/);
  p.node('#move-menu').listeners.click({ target: { closest: () => ({ dataset: { mv: 'f' } }) } });
  await new Promise(setImmediate);
  assert.deepEqual(p.calls.find(c => c.url === '/api/images/move'), {
    url: '/api/images/move', method: 'POST', body: { keys: ['one', 'two'], folderId: 'f' }
  });
  assert.equal(p.state.selectedKeys.size, 0);
});

test('通用预览兼容无任务字段的图库元数据及既有任务，原对象与原图 URL 不变', async () => {
  const p = await fixture(); const before = JSON.stringify(p.images);
  assert.equal(p.app.imageSrc(p.images[1], 0), p.images[1].url);
  p.app.openPreview({ images: p.images }, 100);
  assert.equal(p.node('#pv-img').src, p.images[2].url);
  p.app.openPreview({ templateName: '模板', accountName: '账号', images: p.images }, -1);
  assert.equal(p.node('#pv-title').textContent, '模板 · 配图 1 / 3 · 第一张');
  assert.match(p.node('#pv-thumbs').innerHTML, /\/api\/thumb\/one\?w=240/);
  p.app.openPreview({ accountName: '账号', images: [p.images[1]] }, 0);
  assert.equal(p.node('#pv-title').textContent, '账号 · 配图 1 / 1 · 第二张');
  assert.equal(JSON.stringify(p.images), before);
});

test('图库发布状态筛选每次渲染只计算一次两类 map，独立操作仍按最新 jobs 过滤', async () => {
  const p = await fixture(); p.state.pubFilter = 'pending';
  p.state.jobs = [{ status: 'pending', images: [{ key: 'two' }] }];
  p.counts.pub = p.counts.pend = 0;
  p.renderLibrary();
  assert.deepEqual(p.counts, { pub: 1, pend: 1 });
  assert.match(p.node('#lib-grid').innerHTML, /data-lib="two"/);
  assert.doesNotMatch(p.node('#lib-grid').innerHTML, /data-lib="one"/);
  p.state.jobs = [{ status: 'pending', images: [{ key: 'one' }] }];
  assert.equal(p.viewImages().map(i => i.key).join(','), 'one');
});

test('总览启动与每轮刷新只请求一次 jobs，徽标从已有结果更新，其它页面保留网络刷新', async () => {
  const p = await fixture('dashboard', { jobs: [{ status: 'pending' }, { status: 'publishing' }] });
  assert.equal(p.calls.filter(c => c.url === '/api/jobs').length, 1);
  assert.equal(p.app.state.pendingCount, 1);
  assert.equal(p.node('[data-nav="queue"] em').textContent, 1);
  p.setJobs([{ status: 'failed' }]);
  await p.intervals.find(i => i.ms === 5000).fn();
  assert.equal(p.calls.filter(c => c.url === '/api/jobs').length, 2);
  assert.equal(p.app.state.pendingCount, 0);
  assert.equal(p.node('[data-nav="queue"] em').style.display, 'none');
  p.setJobs([{ status: 'pending' }, { status: 'pending' }]);
  await p.app.refreshBadge();
  assert.equal(p.app.state.pendingCount, 2);
  const other = await fixture();
  assert.equal(other.calls.filter(c => c.url === '/api/jobs').length, 2);
});
