'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Store } = require('../src/store');
const { DEFAULT_TEMPLATES, DEFAULT_BATCH_TEMPLATES } = require('../src/templates');
const TextRender = require('../public/js/text-render');

class FakeStore extends Store {
  constructor(templates = []) {
    super('unused');
    this.data.users = [
      { id: 'admin', username: 'admin', role: 'admin', active: true },
      { id: 'user', username: 'user', role: 'user', active: true }
    ];
    this.data.templates = templates;
    this.data.templateCategoryUsers = ['admin', 'user'];
  }
  save() {}
}

test('2.0.14 默认模板的两种批量署名只含作者和账号', () => {
  for (const templates of [DEFAULT_TEMPLATES(), DEFAULT_BATCH_TEMPLATES()]) {
    assert.ok(templates.every(t => !t.signatureFormat.includes('sourceUrl')));
    assert.deepEqual(templates.filter(t => t.category === 'batch').map(t => t.signatureFormat), [
      '作者：{{author}}\n账号：{{handle}}',
      '原作者：{{author}}\n账号：{{handle}}'
    ]);
  }
  const store = new FakeStore();
  store.data.templateCategoryUsers = [];
  store._migrate();
  for (const user of store.data.users) {
    const templates = store.listTemplates().filter(t => t.userId === user.id && t.category === 'batch');
    assert.equal(templates.length, 2);
    assert.ok(templates.every(t => !t.signatureFormat.includes('sourceUrl')));
  }
});

test('2.0.14 存量迁移覆盖所有用户、所有类别并保留模板 ID 和其他内容', () => {
  const templates = ['admin', 'user'].flatMap(userId => ['dynamic', 'batch'].map(category => ({
    id: userId + '-' + category, userId, category, name: '旧模板',
    content: '作品：{{sourceUrl}}\n正文',
    signatureFormat: '作者：{{author}}\n作品：{{sourceUrl}}\n账号：{{handle}}'
  })));
  const before = structuredClone(templates);
  const store = new FakeStore(templates);
  store._migrate();
  assert.deepEqual(store.listTemplates(), before.map(t => ({ ...t, signatureFormat: '作者：{{author}}\n账号：{{handle}}' })));
  assert.equal(TextRender.render(store.listTemplates()[0].content, { author: '作者名', handle: 'artist', sourceUrl: 'https://example.com/work' }), '作品：https://example.com/work\n正文');
});

test('2.0.14 迁移接受占位符空白、删除重复匹配且不改写行内其他内容', () => {
  const cases = [
    ['作者：{{author}}\n账号：{{handle}}\n作品：{{sourceUrl}}', '作者：{{author}}\n账号：{{handle}}'],
    ['作者：{{author}}\n作品：{{ sourceUrl }}\n账号：{{handle}}', '作者：{{author}}\n账号：{{handle}}'],
    ['作品：{{\tsourceUrl\t}}', ''],
    ['前缀作品：{{sourceUrl}}后缀\n保留内容', '前缀后缀\n保留内容'],
    ['作者\n作品：{{sourceUrl}}\n作品：{{ sourceUrl }}\n账号', '作者\n账号'],
    ['账号：{{handle}}\n链接：{{sourceUrl}}\n作品：固定文字\n作品：{{author}}', '账号：{{handle}}\n链接：{{sourceUrl}}\n作品：固定文字\n作品：{{author}}'],
    ['', '']
  ];
  const store = new FakeStore(cases.map(([signatureFormat], i) => ({ id: 'case-' + i, userId: 'admin', category: 'batch', signatureFormat })));
  store._migrate();
  cases.forEach(([, expected], i) => assert.equal(store.getTemplate('case-' + i).signatureFormat, expected));
  assert.equal(TextRender.render(store.getTemplate('case-0').signatureFormat, { author: '作者名', handle: 'artist', sourceUrl: 'https://example.com/work' }), '作者：作者名\n账号：artist');
});

test('2.0.14 署名迁移幂等且重载后保留用户手工加回的作品链接', () => {
  const store = new FakeStore([{ id: 'old', userId: 'admin', category: 'batch', signatureFormat: '作者：{{author}}\n作品：{{sourceUrl}}' }]);
  store._migrate();
  const migrated = JSON.stringify(store.data);
  store._migrate();
  assert.equal(JSON.stringify(store.data), migrated);
  store.getTemplate('old').signatureFormat += '\n作品：{{sourceUrl}}';
  const saved = JSON.stringify(store.data);
  const reloaded = new FakeStore();
  reloaded.data = JSON.parse(saved);
  reloaded._migrate();
  assert.equal(JSON.stringify(reloaded.data), saved);
});

async function templatePage(template) {
  const elements = new Map();
  let ready;
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { value: '', style: {}, addEventListener() {} });
    return elements.get(key);
  };
  const context = {
    location: { pathname: '/templates/' + (template ? template.id : 'new'), search: '?category=batch' },
    URLSearchParams,
    App: {
      $, $$: () => [], esc: String, icon: () => '', toast() {},
      async api() { return { templates: template ? [template] : [] }; },
      async boot(options) { ready = options.ready; }
    }
  };
  await vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/js/pages/template-edit.js'), 'utf8'), context);
  await ready();
  return $;
}

test('2.0.14 新建批量模板表单默认值及 placeholder 不再含作品链接', async () => {
  const $ = await templatePage();
  assert.equal($('#tf-category').value, 'batch');
  assert.equal($('#tf-signature').value, '作者：{{author}}\n账号：{{handle}}');
  assert.equal($('#tf-signature').disabled, false);
  const html = fs.readFileSync(path.join(__dirname, '../public/template-edit.html'), 'utf8');
  const placeholder = html.match(/<textarea id="tf-signature"[^>]*placeholder="([^"]*)"/);
  assert.ok(placeholder);
  assert.equal(placeholder[1], '作者：{{author}}&#10;账号：{{handle}}');
  assert.match(html, /\{\{sourceUrl\}\} 作品链接/);
});

test('2.0.14 编辑表单保留自定义 sourceUrl 署名', async () => {
  const signatureFormat = '作者：{{author}}\n作品：{{sourceUrl}}';
  const $ = await templatePage({ id: 'custom', category: 'batch', name: '自定义', signatureFormat, content: '{{credit}}', maxImages: 9, variables: [] });
  assert.equal($('#tf-signature').value, signatureFormat);
});

test('2.0.14 sourceUrl 仍可通过模板创建和更新校验并参与署名渲染', async t => {
  const express = require('express');
  const createRoutes = require('../src/routes');
  const store = new FakeStore();
  store._migrate();
  const token = store.createSession('admin');
  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes({ store, storage: {}, bili: {}, scheduler: {} }));
  const server = app.listen(0);
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/templates';
  const input = { name: '自定义署名', category: 'batch', content: '{{credit}}', signatureFormat: '作品：{{sourceUrl}}', variables: [] };
  const request = (method, url, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json', Cookie: 'sid=' + token }, body: JSON.stringify(body) });
  const created = await request('POST', base, input);
  assert.equal(created.status, 200);
  const { template } = await created.json();
  assert.equal(template.signatureFormat, input.signatureFormat);
  const signatureFormat = '作者：{{author}}\n作品：{{sourceUrl}}';
  const updated = await request('PUT', base + '/' + template.id, { ...input, signatureFormat });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).template.signatureFormat, signatureFormat);
  store._migrate();
  assert.equal(store.getTemplate(template.id).signatureFormat, signatureFormat);
  assert.equal(TextRender.render(store.getTemplate(template.id).signatureFormat, { author: '作者名', sourceUrl: 'https://example.com/work' }), '作者：作者名\n作品：https://example.com/work');
});
