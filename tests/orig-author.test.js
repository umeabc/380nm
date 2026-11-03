'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderTemplate } = require('../src/render');

test('原作者各大小写共享值，旧 credit 兜底，其他变量保持大小写敏感', () => {
  const content = '{{OrigAuthor}}/{{origAuthor}}/{{origauthor}}/{{title}}/{{Title}}';
  assert.equal(renderTemplate(content, { origAuthor: '新作者', credit: '旧说明', title: '标题' }), '新作者/新作者/新作者/标题/');
  assert.equal(renderTemplate(content, { origAuthor: '', credit: '旧说明' }), '旧说明/旧说明/旧说明//');
  assert.equal(renderTemplate(content, { origauthor: '旧作者' }), '旧作者/旧作者/旧作者//');
  assert.equal(renderTemplate(content), '////');
});

test('前端原作者编辑、发布页共用作者说明及模板下载控件接线', () => {
  const fs = require('node:fs');
  const read = file => fs.readFileSync(require('node:path').join(__dirname, '..', file), 'utf8');
  const drafts = read('public/js/pages/drafts.js');
  assert.match(drafts, /data-edit="variable" data-key="origAuthor"/);
  assert.match(drafts, /edit\.pending\.variables = \{ \.\.\.draft\.variables \}/);
  const batch = read('public/js/pages/batch.js');
  assert.match(batch, /data-field="origAuthor"/);
  assert.match(batch, /origAuthor: e\.target\.value/);
  assert.match(batch, /variables: \{ \.\.\.row\.variables/);
  const release = read('public/js/pages/release.js');
  assert.match(release, /credit: state\.credit\.text, origAuthor: state\.credit\.text/);
  assert.match(release, /\['origauthor', 'credit'\]\.includes/);
  for (const page of ['drafts', 'queue']) {
    assert.match(read('public/' + page + '.html'), /id="downloadTemplate"/);
    assert.match(read('public/js/pages/' + page + '.js'), /\?templateId=.*encodeURIComponent\(downloadSelect\.value\)/);
  }
});

test('shared body renderer refreshes signatures and explains unused authors', () => {
  const Text = require('../public/js/text-render');
  const { renderBody } = require('../src/render');
  for (const key of ['origAuthor', 'OrigAuthor', 'origauthor']) {
    const tpl = { content: '{{credit}} / {{OrigAuthor}}', signatureFormat: 'By {{' + key + '}}' };
    assert.equal(renderBody(tpl, { origAuthor: 'New', credit: 'Old' }), 'By New / New');
    assert.equal(Text.hint(tpl), '');
  }
  assert.ok(Text.hint({ content: '{{credit}}', variables: [{ key: 'origAuthor' }] }));
  assert.ok(Text.hint({ content: '{{body}}', signatureFormat: '{{origAuthor}}' }));
  assert.equal(Text.hint({ content: '{{OrigAuthor}}', variables: [] }), '');
});
