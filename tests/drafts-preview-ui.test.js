'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = file => fs.readFileSync(require('node:path').join(__dirname, '../public/', file), 'utf8');

async function page() {
  const calls = [];
  const context = { window: {}, TextRender: require('../public/js/text-render'), Staff: require('../public/js/staff'),
    App: { esc: String, imageSrc: () => '/thumb', boot: async () => {}, openPreview: (...args) => calls.push(args) } };
  await vm.runInNewContext(read('js/pages/drafts.js').replace(/\}\)\(\);\s*$/, 'window.testing = { state, cardHtml, previewImage }; })();'), context);
  return { ...context.window.testing, calls };
}
test('draft double click opens the selected image and stops propagation', async () => {
  const p = await page();
  const draft = { id: 'd', images: [{ url: '/original1' }, { url: '/original2' }] };
  p.state.drafts = [draft];
  let prevented = 0, stopped = 0;
  const thumb = { dataset: { imageIndex: '1' }, closest: () => ({ dataset: { draft: 'd' } }) };
  p.previewImage({ target: { closest: () => thumb }, preventDefault: () => prevented++, stopPropagation: () => stopped++ });
  assert.equal(p.calls[0][0], draft);
  assert.equal(p.calls[0][1], 1);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  const source = read('js/pages/drafts.js');
  assert.match(source, /addEventListener\('dblclick', previewImage\)/);
  assert.match(source, /if \(event.target.closest\('\[data-image-index\]'\)\) \{ event.preventDefault\(\); event.stopPropagation\(\); return; \}/);
});
test('draft footer keeps edit, publish, delete before metadata and incomplete publish disabled', async () => {
  const p = await page();
  const html = p.cardHtml({ id: 'd', incomplete: true });
  assert.match(html, /draft-footer"><div class="draft-actions">.*>编辑<\/a>.*disabled title="请填写正文、发布时间".*>入队<\/button>.*>删除<\/button><\/div><div class="draft-meta">/);
  assert.ok(html.indexOf('draft-footer') < html.indexOf('draft-preview-panel'));
  assert.match(read('css/app.css'), /@media\(width < 760px\)\{\.draft-footer\{flex-wrap:wrap\}/);
});
test('shared preview uses original images, wraps keyboard navigation and closes by backdrop or Escape', () => {
  const nodes = new Map(), handlers = {};
  const node = id => { if (!nodes.has(id)) nodes.set(id, { style: {}, addEventListener: (type, fn) => { handlers[type] = fn; } }); return nodes.get(id); };
  const document = { getElementById: id => nodes.get(id), createElement: () => node('pv-modal'), body: { appendChild() {} }, addEventListener: (type, fn) => { handlers[type] = fn; } };
  for (const id of ['pv-img', 'pv-imgwrap', 'pv-title', 'pv-thumbs']) node(id);
  const ctx = { window: {}, document };
  vm.runInNewContext(read('js/common.js'), ctx);
  ctx.window.App.openPreview({ images: [{ url: '/one' }, { url: '/two' }] }, 1);
  assert.equal(node('pv-img').src, '/two');
  handlers.keydown({ key: 'ArrowRight' }); assert.equal(node('pv-img').src, '/one');
  handlers.keydown({ key: 'ArrowLeft' }); assert.equal(node('pv-img').src, '/two');
  handlers.keydown({ key: 'Escape' }); assert.equal(node('pv-modal').style.display, 'none');
  ctx.window.App.openPreview({ images: [{ url: '/one' }] }, 0);
  handlers.click({ target: { closest: selector => selector === '[data-pv-close]' } });
  assert.equal(node('pv-modal').style.display, 'none');
});
