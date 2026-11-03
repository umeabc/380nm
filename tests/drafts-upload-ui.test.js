'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

async function releasePage(draft) {
  const elements = new Map();
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { value: '', textContent: '', innerHTML: '', classList: { toggle() {} }, querySelector: () => null, querySelectorAll: () => [] });
    return elements.get(key);
  };
  const messages = [];
  const context = {
    URLSearchParams, location: { search: '?draft=d1' }, window: {},
    App: { $, $$: () => [], esc: String, imageSrc: image => image.url,
      publishedImageMap: () => ({}), pendingImageMap: () => ({}),
      toast: message => messages.push(message), api: async () => ({ drafts: [draft] }), boot: async () => {} }
  };
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/release.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, restoreDraft, isReady: () => draftReady, template: () => activeTplId }; })();');
  context.TextRender = require('../public/js/text-render');
  context.Staff = require('../public/js/staff');
  await vm.runInNewContext(source, context);
  const page = context.window.testing;
  page.state.templates = [{ id: 't1', name: '模板', content: '{{body}}', variables: [{ key: 'body', type: 'textarea' }], maxImages: 9 }];
  return { ...page, $, messages };
}

test('缺模板的新草稿正常回填：选择器留空、正文为空、图片保留且可更新', async () => {
  const page = await releasePage({ id: 'd1', templateId: null, text: '', variables: {}, images: [{ key: 'i1', name: '一.png', url: '/uploads/i1' }], incomplete: true });
  await page.restoreDraft();
  assert.equal(page.isReady(), true);
  assert.equal(page.$('#btn-save-draft').disabled, false);
  assert.equal(page.$('#btn-save-draft').textContent, '更新草稿');
  assert.equal(page.template(), '');
  assert.equal(page.$('#sel-template').value, '');
  assert.equal(Object.keys(page.state.vars).length, 0);
  assert.equal(page.state.selected.length, 1);
  assert.equal(page.state.selected[0].key, 'i1');
  assert.doesNotMatch(page.messages.join('\n'), /无法回填/);
});

test('原有模板被删除仍防止回填失败后误覆盖', async () => {
  const page = await releasePage({ id: 'd1', templateId: 'removed', images: [] });
  await page.restoreDraft();
  assert.equal(page.isReady(), false);
  assert.equal(page.$('#btn-save-draft').disabled, true);
  assert.match(page.messages.join('\n'), /模板已不可用/);
});

test('草稿列表保持未完善入队禁用，多选刷新不会重新启用', async () => {
  const elements = new Map();
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { textContent: '', innerHTML: '', classList: { toggle() {} } });
    return elements.get(key);
  };
  const button = { dataset: { publish: 'd1' }, disabled: false };
  const context = { window: {}, App: { $, $$: key => key === '#list [data-publish]' ? [button] : [], esc: String, fmtTime: String, boot: async () => {} } };
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/drafts.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, renderList, renderSelection }; })();');
  context.TextRender = require('../public/js/text-render');
  context.Staff = require('../public/js/staff');
  await vm.runInNewContext(source, context);
  const page = context.window.testing;
  page.state.drafts = [{ id: 'd1', incomplete: true }];
  page.renderList();
  assert.equal(button.disabled, true);
  assert.match($('#list').innerHTML, /未完善草稿/);
  assert.match($('#list').innerHTML, /disabled title="请填写正文、发布时间"/);
  assert.match($('#list').innerHTML, /data-edit="title" maxlength="20"/);
  assert.match($('#list').innerHTML, /type="datetime-local" data-edit="scheduledAt"/);
  assert.match($('#list').innerHTML, />入队<\/button>/);
  page.state.deleting = true;
  page.renderSelection();
  page.state.deleting = false;
  page.renderSelection();
  assert.equal(button.disabled, true);
  page.state.drafts[0].incomplete = false;
  page.renderSelection();
  assert.equal(button.disabled, false);
});

async function draftListPage(api = async () => ({})) {
  const elements = new Map();
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { textContent: '', innerHTML: '', classList: { toggle() {} }, querySelectorAll: () => [] });
    return elements.get(key);
  };
  const context = { window: {}, document: {}, clearTimeout, setTimeout,
    App: { $, $$: () => [], api, toast() {}, esc: String, imageSrc: image => image.url,
      toLocalInput: date => date.toISOString().slice(0, 16), boot: async () => {} } };
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/drafts.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, editor, saveDraft, inlineFields, cardHtml, bindStaffEditor, editDraft }; })();');
  context.TextRender = require('../public/js/text-render');
  context.Staff = require('../public/js/staff');
  await vm.runInNewContext(source, context);
  return { ...context.window.testing, $ };
}

test('内联字段完全来自模板变量定义，textarea 与标题计数、排期同时存在', async () => {
  const page = await draftListPage();
  page.state.templates = [{ id: 't', content: '{{unusual}} {{translator}}', variables: [{ key: 'unusual', label: '任意字段', type: 'textarea' }, { key: 'translator', label: '翻译', type: 'text' }] }];
  const html = page.inlineFields({ id: 'd', templateId: 't', title: '标题', variables: { unusual: '两行\n正文', translator: '译者' } });
  assert.match(html, /<textarea[^>]*data-key="unusual"[^>]*>两行\n正文<\/textarea>/);
  assert.match(html, /data-staff-add/);
  assert.doesNotMatch(html, /<input[^>]*data-key="translator"/);
  assert.match(html, /2\/20/);
  assert.match(html, /maxlength="20"/);
  assert.match(html, /type="datetime-local"/);
  assert.doesNotMatch(html, /data-key="handle"/);
  assert.doesNotMatch(html, /data-preview|draft-schedule-preview/);
  assert.match(page.cardHtml({ id: "d" }), /<textarea[^>]*data-preview[^>]*readonly[^>]*rows="5"[^>]*placeholder="正文将在这里预览"/);
  assert.match(html, /foot-hint/);
  assert.ok(html.includes(require('../public/js/text-render').hint(page.state.templates[0])));

});

test('内联保存串行补发在途修改，不覆盖最新值', async () => {
  const calls = [];
  let finish;
  const page = await draftListPage(async (method, url, patch) => {
    calls.push({ ...patch });
    if (calls.length === 1) await new Promise(resolve => { finish = resolve; });
    return { draft: { id: 'd', title: patch.title, text: '正文', scheduledAt: '2030-01-01T00:00:00Z', incomplete: false } };
  });
  page.state.drafts = [{ id: 'd', title: '旧标题' }];
  page.editor('d').pending = { title: '第一次' };
  const first = page.saveDraft('d');
  page.editor('d').pending = { title: '第二次' };
  const second = page.saveDraft('d');
  finish();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [{ title: '第一次' }, { title: '第二次' }]);
  assert.equal(page.state.drafts[0].title, '第二次');
  assert.equal(Object.keys(page.editor('d').pending).length, 0);
});

test('内联保存失败保留脏数据并阻止入队，重试可恢复', async () => {
  let fail = true;
  const page = await draftListPage(async () => {
    if (fail) throw new Error('网络失败');
    return { draft: { id: 'd', title: '待保存', incomplete: true } };
  });
  page.state.drafts = [{ id: 'd' }];
  page.editor('d').pending = { title: '待保存' };
  assert.equal(await page.saveDraft('d'), false);
  assert.equal(page.editor('d').pending.title, '待保存');
  fail = false;
  assert.equal(await page.saveDraft('d'), true);
  assert.equal(page.state.drafts[0].title, '待保存');
});

test('草稿人员池真实事件加入/移除并经原保存队列写入有序数组', async () => {
  const calls = [];
  const page = await draftListPage(async (method, url, patch) => {
    calls.push({ method, url, patch });
    return { draft: { id: 'd', staff: patch.staff, text: '正文', incomplete: false } };
  });
  page.state.libAccounts = [{ id: 'p1', name: '甲', handle: 'one' }, { id: 'p2', name: '乙', handle: 'two' }];
  page.state.drafts = [{ id: 'd', staff: [], variables: {} }];
  const add = { value: '', addEventListener(type, listener) { this[type] = listener; } };
  const remove = { dataset: { staffRemove: '0' }, addEventListener(type, listener) { this[type] = listener; } };
  const box = { dataset: {}, querySelector: () => add, querySelectorAll: () => [remove] };
  page.bindStaffEditor(box, 'd');
  add.value = 'p2'; add.change(); add.value = 'p1'; add.change();
  assert.equal(page.editor('d').pending.staff.join(','), 'p2,p1');
  assert.match(box.innerHTML, /1\. 乙/);
  await page.saveDraft('d');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(calls[0].patch.staff.join(','), 'p2,p1');
  remove.click();
  await page.saveDraft('d');
  assert.equal(calls[1].patch.staff.join(','), 'p1');
  assert.equal(page.state.drafts[0].staff.join(','), 'p1');
});

test('草稿布局在精确 760/1200 断点切换，标题双列且长字段整行', async () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /\.draft-inline\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(min-width:1200px\)\{\.draft-inline\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}\}/);
  assert.match(css, /@media\(width < 760px\)\{\.draft-inline\{grid-template-columns:1fr\}\.draft-title-field\{grid-column:span 1\}\}/);
  assert.match(css, /\.draft-wide\{grid-column:1\/-1\}/);
  assert.match(css, /\.draft-title-field\{grid-column:span 2\}/);
  const page = await draftListPage();
  page.state.templates = [{ id: 't', variables: [{ key: 'body', type: 'textarea' }, { key: 'short', type: 'text' }, { key: 'title', type: 'text' }] }];
  const html = page.inlineFields({ id: 'd', templateId: 't' });
  assert.match(html, /class="draft-field draft-wide"[^]*?<textarea[^>]*data-key="body"/);
  assert.match(html, /class="draft-field "[^]*?<input[^>]*data-key="short"/);
  assert.match(html, /class="draft-field draft-title-field"[^]*?<input[^>]*data-key="title"/);
});

test('saved draft preview uses the exact server-rendered multiline text', async () => {
  const rendered = 'By Artist\nLine 1\nLine 2';
  const page = await draftListPage(async () => ({ draft: { id: 'd', title: '', text: rendered, incomplete: false } }));
  const fields = new Map();
  const card = { dataset: { draft: 'd' }, querySelector(selector) {
    if (!fields.has(selector)) fields.set(selector, { value: '', textContent: '' });
    return fields.get(selector);
  } };
  page.$('#list').querySelectorAll = () => [card];
  page.state.drafts = [{ id: 'd', variables: {} }];
  page.editor('d').pending = { variables: { origAuthor: 'Artist' } };
  assert.equal(await page.saveDraft('d'), true);
  assert.equal(fields.get('[data-preview]').value, rendered);
});

test('Preview columns stretch at 1100 and stack below with a stable empty state', async () => {
  const css = fs.readFileSync(path.join(__dirname, '../public/css/app.css'), 'utf8');
  assert.match(css, /@media\(min-width:1100px\)\{\.draft-content\{grid-template-columns:minmax\(0,1fr\) minmax\(280px,34%\)/);
  assert.match(css, /\.draft-content\{[^}]*align-items:stretch/);
  assert.match(css, /@media\(width < 1100px\)\{\.draft-preview-panel\{height:164px;min-height:164px/);
  assert.match(css, /\.draft-preview\{[^}]*resize:none;overflow:auto/);
  assert.match(css, /\.draft-preview::placeholder\{color:var\(--text-3\)/);
  const page = await draftListPage();
  const html = page.cardHtml({ id: 'd', text: '' });
  assert.match(html, /<\/div><label class="draft-preview-panel"><span>正文预览<\/span>/);
  assert.match(html, /readonly[^>]*placeholder="正文将在这里预览"><\/textarea>/);
  assert.equal((html.match(/data-preview/g) || []).length, 1);
});

test('each inline edit replaces preview with authoritative server text including empty text', async () => {
  const patches = [{ title: 'New title' }, { variables: { origAuthor: 'Artist' } }, { variables: { body: 'Body' } }, { staff: ['p1'] }, { variables: { body: '' } }];
  let responseText;
  const page = await draftListPage(async () => ({ draft: { id: 'd', text: responseText, incomplete: false } }));
  const preview = { value: 'old' };
  const card = { dataset: { draft: 'd' }, querySelector: selector => selector === '[data-preview]' ? preview : { textContent: '' } };
  page.$('#list').querySelectorAll = () => [card];
  page.state.drafts = [{ id: 'd' }];
  for (const [index, patch] of patches.entries()) {
    responseText = index === patches.length - 1 ? '' : 'Server final ' + index;
    page.editor('d').pending = patch;
    assert.equal(await page.saveDraft('d'), true);
    assert.equal(preview.value, responseText);
    assert.equal(page.state.drafts[0].text, responseText);
  }
});
