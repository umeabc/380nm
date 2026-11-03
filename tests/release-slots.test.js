const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
async function page() {
  const elements = new Map();
  const $ = key => { if (!elements.has(key)) elements.set(key, { hidden: false, innerHTML: '', querySelector: () => null, querySelectorAll: () => [] }); return elements.get(key); };
  const context = { URLSearchParams, location: { search: '' }, window: {}, App: { $, $$: () => [], esc: String, renderText: require('../src/render').renderTemplate, boot: async () => {} } };
  let source = fs.readFileSync(path.join(__dirname, '../public/js/pages/release.js'), 'utf8');
  source = source.replace(/\}\)\(\);\s*$/, 'window.testing = { state, renderPeople, defaultAccount, collectJobPayload, collectDraftPayload, composeBodyHTML, useTemplate(t) { state.templates = [t]; activeTplId = t.id; } }; })();');
  context.TextRender = require('../public/js/text-render');
  context.Staff = require('../public/js/staff');
  await vm.runInNewContext(source, context);
  return { ...context.window.testing, $ };
}
test('person controls follow placeholders in content and signature, not variable declarations', async () => {
  const pageApi = await page();
  pageApi.useTemplate({ id: 't', content: '{{body}}', variables: [{ key: 'translator' }] });
  pageApi.renderPeople();
  assert.equal(pageApi.$('#var-people').hidden, true);
  pageApi.useTemplate({ id: 't', content: '{{ translator }}', signatureFormat: '{{typesetter}}' });
  pageApi.renderPeople();
  assert.equal(pageApi.$('#var-people').hidden, false);
  assert.match(pageApi.$('#var-people').innerHTML, /data-staff-add/);
  assert.match(pageApi.$('#var-people').innerHTML, /参与人员/);
  pageApi.useTemplate({ id: 't', content: '{{typesetter}}' }); pageApi.renderPeople();
  assert.doesNotMatch(pageApi.$('#var-people').innerHTML, /data-person="translator"/);
  assert.equal(pageApi.$('#var-people').hidden, false);
  pageApi.useTemplate({ id: 't', content: '{{staff12}}' }); pageApi.renderPeople();
  assert.equal(pageApi.$('#var-people').hidden, false);
});
test('default account belongs to current user even when an admin sees other accounts first', async () => {
  const { defaultAccount } = await page();
  const accounts = [{ id: 'other', userId: 'b' }, { id: 'first', userId: 'a' }, { id: 'second', userId: 'a' }];
  assert.equal(defaultAccount(accounts, { id: 'a' }), 'first');
  assert.equal(defaultAccount(accounts, { id: 'c' }), '');
});

test('release submits all selected IDs in order and allows empty personnel placeholders', async () => {
  const p = await page();
  p.useTemplate({ id: 't', content: '正文 {{staff1}} {{staff3}} {{staff41}} {{translator}} {{typesetter}}', variables: [{ key: 'translator' }, { key: 'staff41' }], maxImages: 9 });
  p.$('#sel-account').value = 'acc'; p.$('#dyn-title').value = ''; p.$('#time-input').value = '';
  p.state.staff = Array.from({ length: 40 }, (_, i) => ({ id: 'p' + i, handle: 'h' + i }));
  const payload = p.collectJobPayload();
  assert.equal(payload.staff.length, 40);
  assert.equal(payload.staff.join(','), p.state.staff.map(person => person.id).join(','));
  assert.equal(payload.variables.translator, '@h0');
  assert.equal(payload.variables.typesetter, '@h1');
  assert.equal(payload.variables.staff40, '@h39');
  assert.doesNotMatch(p.composeBodyHTML(), /\{\{/);
  assert.equal(p.collectDraftPayload().staff.length, 40);
  p.state.staff = [];
  assert.equal(p.collectJobPayload().staff.length, 0);
  assert.equal(p.composeBodyHTML(), '正文     ');
});

test('legacy text-only credits survive opening and saving until the user changes the personnel pool', async () => {
  const p = await page();
  p.useTemplate({ id: 't', content: '{{translator}} {{typesetter}}', variables: [], maxImages: 9 });
  p.$('#dyn-title').value = '';
  p.state.legacyStaffVariables = { translator: '@deleted-member', typesetter: '旧署名' };
  const payload = p.collectDraftPayload();
  assert.equal(Object.hasOwn(payload, 'staff'), false);
  assert.equal(payload.variables.staff1, '@deleted-member');
  assert.equal(payload.variables.typesetter, '旧署名');
  assert.match(p.composeBodyHTML(), /@deleted-member/);
  p.state.legacyStaffVariables = {};
  p.state.staff = [{ id: 'p', handle: 'new' }];
  assert.equal(p.collectDraftPayload().staff[0], 'p');
  assert.equal(p.collectDraftPayload().variables.typesetter, '');
});

test('release author description preview equals final rendered signature and body', async () => {
  const p = await page();
  const tpl = { id: 't', content: '{{credit}} / {{OrigAuthor}}', signatureFormat: 'By {{origAuthor}}', variables: [] };
  p.useTemplate(tpl); p.state.credit.text = 'Artist'; p.$('#dyn-title').value = '';
  const payload = p.collectDraftPayload();
  assert.equal(p.composeBodyHTML(), require('../src/render').renderBody(tpl, payload.variables));
  assert.equal(p.composeBodyHTML(), 'By Artist / Artist');
});
