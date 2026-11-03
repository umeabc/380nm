'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Store } = require('../src/store');
const Staff = require('../src/staff');
const { renderTemplate } = require('../src/render');
const createRoutes = require('../src/routes');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-staff-'));
  const store = new Store(path.join(dir, 'db.json'));
  store.data.users = [{ id: 'u', username: 'u', role: 'user', active: true }];
  store.data.accounts = [{ id: 'acc', userId: 'u', name: '发布账号' }];
  store.data.templates = [{ id: 'tpl', userId: 'u', name: '人员模板', content: '{{body}}|{{staff1}}|{{staff2}}|{{staff3}}|{{staff40}}|{{staff41}}|{{translator}}|{{typesetter}}', variables: [{ key: 'body', type: 'textarea' }], maxImages: 9 }];
  store.data.libAccounts = Array.from({ length: 40 }, (_, i) => ({ id: 'p' + (i + 1), userId: 'u', name: '成员' + (i + 1), handle: 'h' + (i + 1), uid: String(i + 100), status: '在岗' }));
  store.data.libAccounts.push({ id: 'foreign', userId: 'other', name: '他人', handle: 'foreign' });
  const token = store.createSession('u');
  const app = express(); app.use(express.json());
  app.use('/api', createRoutes({ store, storage: {}, bili: {}, scheduler: {} }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.flushNow(); await fs.rm(dir, { recursive: true, force: true }); });
  const request = async (method, endpoint, body) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/api' + endpoint, {
      method, headers: { Cookie: 'sid=' + token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const input = { templateId: 'tpl', accountId: 'acc', variables: { body: '正文' }, scheduledAt: '2030-01-01T00:00:00Z', images: [], type: '原创' };
  return { store, request, input };
}

test('staff renderer supports arbitrary positions, aliases, explicit clearing and legacy text', () => {
  const template = '{{ staff1 }}|{{staff2}}|{{staff12}}|{{staff99999999999999999}}|{{translator}}|{{ typesetter }}';
  assert.equal(renderTemplate(template, { translator: '@旧甲', typesetter: '@旧乙' }), '@旧甲|@旧乙|||@旧甲|@旧乙');
  assert.equal(renderTemplate(template, { translator: '@旧甲', staff1: '@新甲' }), '@新甲||||@新甲|');
  assert.equal(renderTemplate(template, { translator: '@旧甲', staff12: '不应残留' }, []), '|||||');
  assert.equal(renderTemplate(template, {}, [{ handle: 'one' }, { handle: '@two' }]), '@one|@two|||@one|@two');
});

test('POST drafts and jobs persist 40 ordered account snapshots and render server-owned handles', async t => {
  const { store, request, input } = await fixture(t);
  const staff = store.listLibAccounts().filter(p => p.userId === 'u').map(p => ({ id: p.id, handle: 'forged', uid: '999' }));
  const expected = '正文|@h1|@h2|@h3|@h40||@h1|@h2';
  for (const endpoint of ['/drafts', '/jobs']) {
    const result = await request('POST', endpoint, { ...input, staff, variables: { body: '正文', translator: 'forged', staff41: 'forged' } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const record = result.body.draft || result.body.job;
    assert.equal(record.text, expected);
    assert.equal(record.staff.length, 40);
    assert.deepEqual(record.staff.map(p => p.id), staff.map(p => p.id));
    assert.equal(record.staff[0].uid, '100');
    assert.equal(record.slots.translator, undefined);
  }
});

test('draft PATCH add/remove/reorder re-renders aliases, then publish preserves payload and schedule', async t => {
  const { store, request, input } = await fixture(t);
  const created = await request('POST', '/drafts', { ...input, staff: ['p1', 'p2', 'p3'] });
  const id = created.body.draft.id;
  const changed = await request('PATCH', '/drafts/' + id, { staff: ['p3', 'p1'] });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.draft.text, '正文|@h3|@h1||||@h3|@h1');
  assert.equal(changed.body.draft.incomplete, false);
  const queued = await request('POST', '/drafts/' + id + '/publish', {});
  assert.equal(queued.status, 200);
  assert.deepEqual(queued.body.job.staff.map(p => p.id), ['p3', 'p1']);
  assert.equal(queued.body.job.text, changed.body.draft.text);
  assert.equal(queued.body.job.scheduledAt, '2030-01-01T00:00:00.000Z');
  assert.equal(store.getDraft(id), undefined);
  const edited = await request('PUT', '/jobs/' + queued.body.job.id, { staff: ['p2'] });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.job.text, '正文|@h2|||||@h2|');
  assert.deepEqual(edited.body.job.staff.map(p => p.id), ['p2']);
});

test('invalid and foreign staff are rejected atomically on POST, PATCH and job edit', async t => {
  const { store, request, input } = await fixture(t);
  const draft = (await request('POST', '/drafts', { ...input, staff: ['p1'] })).body.draft;
  const job = (await request('POST', '/jobs', { ...input, staff: ['p1'] })).body.job;
  const before = JSON.stringify(store.getDraft(draft.id));
  for (const staff of [null, 'p1', {}, [null], [1], [{}], [['p1']], ['missing'], ['foreign'], ['p1', 'p1']]) {
    assert.equal((await request('POST', '/drafts', { ...input, staff })).status, 400);
    assert.equal((await request('POST', '/jobs', { ...input, staff })).status, 400);
    assert.equal((await request('PATCH', '/drafts/' + draft.id, { staff, title: '不应写入' })).status, 400);
    assert.equal((await request('PUT', '/jobs/' + job.id, { staff })).status, 400);
    assert.equal(JSON.stringify(store.getDraft(draft.id)), before);
  }
  assert.equal(store.listDrafts().length, 1);
  assert.equal(store.listJobs().length, 1);
});

test('legacy slots read in order; clearing staff never resurrects old slots or variable text', async t => {
  const { store, request, input } = await fixture(t);
  const slots = { translator: 'p2', typesetter: { id: 'p1', handle: 'old-h1' } };
  const created = await request('POST', '/drafts', { ...input, slots });
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.draft.staff.map(p => p.id), ['p2', 'p1']);
  assert.equal(created.body.draft.text, '正文|@h2|@h1||||@h2|@h1');
  store.data.drafts.push({ id: 'old', userId: 'u', ...input, slots, text: '历史正文' });
  store.data.jobs.push({ id: 'old-job', userId: 'u', slots, text: '历史任务' });
  const drafts = (await request('GET', '/drafts')).body.drafts;
  assert.deepEqual(drafts.find(d => d.id === 'old').staff.map(p => p.id), ['p2', 'p1']);
  assert.equal(drafts.find(d => d.id === 'old').text, '历史正文');
  const jobs = (await request('GET', '/jobs')).body.jobs;
  assert.deepEqual(jobs.find(j => j.id === 'old-job').staff.map(p => p.id), ['p2', 'p1']);
  const cleared = await request('PATCH', '/drafts/old', { staff: [] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.draft.staff, []);
  assert.deepEqual(cleared.body.draft.slots, {});
  assert.equal(cleared.body.draft.text, '正文|||||||');
  const resaved = await request('PATCH', '/drafts/old', { variables: { body: '更新', translator: '残留', staff3: '残留' } });
  assert.equal(resaved.body.draft.text, '更新|||||||');
  assert.deepEqual(resaved.body.draft.staff, []);
});

test('batch saves, restores and enqueues many staff with aliases in body and signature', async t => {
  const { store, request } = await fixture(t);
  const template = await request('POST', '/templates', {
    name: '批量人员', category: 'batch', content: '{{credit}}\n{{body}} / {{staff3}} / {{translator}} / {{typesetter}} / {{staff41}}',
    signatureFormat: '{{author}} {{staff1}} {{staff12}} {{translator}} {{staff41}}', variables: [], maxImages: 9
  });
  assert.equal(template.status, 200);
  const row = { id: 'row', status: 'ready', config: { accountId: 'acc', templateId: template.body.template.id }, staff: Array.from({ length: 40 }, (_, i) => 'p' + (i + 1)), images: [], selectedImages: [], body: '内容', variables: { author: '作者', staff41: '不得渲染' }, scheduledAt: '2030-01-01T00:00:00Z' };
  const saved = await request('PUT', '/batch-draft', { revision: 0, rows: [row], config: { staff: ['p2', 'p1'] } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.rows[0].staff.length, 40);
  const restored = (await request('GET', '/batch-draft')).body;
  assert.deepEqual(restored.config.staff.map(p => p.id), ['p2', 'p1']);
  for (const body of [{ rows: [{ ...row, staff: ['foreign'] }], config: {} }, { rows: [row], config: { staff: {} } }]) {
    assert.equal((await request('PUT', '/batch-draft', { ...body, revision: saved.body.revision })).status, 400);
    assert.equal(store.getBatchDraft('u').revision, saved.body.revision);
  }
  const queued = await request('POST', '/batch-draft/enqueue', { revision: saved.body.revision, rowIds: ['row'] });
  assert.deepEqual(queued.body.failed, []);
  const job = store.listJobs()[0];
  assert.equal(job.staff.length, 40);
  assert.equal(job.text, '作者 @h1 @h12 @h1 \n内容 / @h3 / @h1 / @h2 /');
  assert.doesNotMatch(job.text, /\{\{|不得渲染/);
});

test('disk migration retains old draft/job text and handles missing library accounts without crashing', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-staff-migration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'db.json');
  const person = { id: 'p1', name: '旧成员', handle: 'old', uid: '123' };
  await fs.writeFile(file, JSON.stringify({ users: [{ id: 'u', role: 'admin' }],
    drafts: [{ id: 'd', userId: 'u', text: '草稿原文', slots: { translator: person, typesetter: 'gone' } }],
    jobs: [{ id: 'j', userId: 'u', text: '任务原文', slots: { translator: person } }, { id: 'empty', userId: 'u', staff: [], slots: { translator: person } }],
    batchDrafts: [{ userId: 'u', config: { people: { translator: 'p1', typesetter: 'p2' } }, rows: [{ config: { people: { translator: 'p2' } } }] }]
  }));
  const store = new Store(file); await store.init();
  assert.deepEqual(store.getDraft('d').staff.map(p => p.id), ['p1', 'gone']);
  assert.equal(store.getDraft('d').staff[0].handle, 'old');
  assert.equal(store.getDraft('d').text, '草稿原文');
  assert.equal(store.getJob('j').text, '任务原文');
  assert.deepEqual(store.getJob('empty').staff, []);
  assert.deepEqual(store.getJob('j').slots, {});
  assert.deepEqual(store.getBatchDraft('u').config.staff.map(p => p.id), ['p1', 'p2']);
  const second = new Store(file); await second.init();
  assert.deepEqual(second.getDraft('d'), store.getDraft('d'));
  assert.deepEqual(Staff.readStaff({ staff: [null, [], 'missing'] }).map(p => p.id), ['missing']);
});
