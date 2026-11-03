/* 测试：批量编排草稿持久化与入队 */
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');

let app, server, port;
const cookies = { user: 'sid=user-token', other: 'sid=other-token' };

class FakeStore {
  constructor() {
    this.data = {
      users: [
        { id: 'usr_test', username: 'test', role: 'user', active: true, passwordHash: 'fake' },
        { id: 'usr_other', username: 'other', role: 'user', active: true, passwordHash: 'fake' }
      ],
      accounts: [
        { id: 'acc_test', userId: 'usr_test', name: '测试账号', sessdata: 'fake', bili_jct: 'fake' },
        { id: 'acc_other', userId: 'usr_other', name: '他人账号', sessdata: 'fake', bili_jct: 'fake' }
      ],
      templates: [
        { id: 'tpl_test', userId: 'usr_test', name: '测试模板', content: '{{content}}', variables: [{ key: 'content', type: 'textarea' }], maxImages: 3 },
        { id: 'tpl_other', userId: 'usr_other', name: '他人模板', content: '{{content}}', variables: [{ key: 'content', type: 'textarea' }], maxImages: 3 }
      ],
      images: [], jobs: [], logs: [], libAccounts: [], batchDrafts: []
    };
    this.saveCount = 0;
    this.flushCount = 0;
  }
  reset() {
    this.data.jobs = [];
    this.data.logs = [];
    this.data.batchDrafts = [];
    this.saveCount = 0;
    this.flushCount = 0;
  }
  getUser(id) { return this.data.users.find(user => user.id === id) || null; }
  getSession(token) {
    if (token === 'user-token') return { user: this.data.users[0] };
    if (token === 'other-token') return { user: this.data.users[1] };
    return null;
  }
  listAccounts() { return this.data.accounts; }
  getAccount(id) { return this.data.accounts.find(account => account.id === id) || null; }
  listTemplates() { return this.data.templates; }
  getTemplate(id) { return this.data.templates.find(template => template.id === id) || null; }
  listImages() { return this.data.images; }
  listJobs() { return this.data.jobs; }
  listLibAccounts() { return this.data.libAccounts; }
  addJobSilent(job) { this.data.jobs.push(job); return job; }
  addLogSilent(level, message, extra) { this.data.logs.unshift({ level, message, ...extra }); }
  getBatchDraft(userId) { return this.data.batchDrafts.find(draft => draft.userId === userId) || null; }
  async saveBatchDraft(userId, rows, config) {
    const index = this.data.batchDrafts.findIndex(draft => draft.userId === userId);
    const draft = {
      userId,
      revision: index >= 0 ? this.data.batchDrafts[index].revision + 1 : 1,
      rows: structuredClone(rows),
      config: structuredClone(config || {}),
      updatedAt: new Date().toISOString()
    };
    if (index >= 0) this.data.batchDrafts[index] = draft;
    else this.data.batchDrafts.push(draft);
    this.save();
    return draft;
  }
  save() { this.saveCount++; }
  async flushNow() { this.flushCount++; }
}

class FakeBilibili {
  async searchTopic() { return []; }
  async searchMention() { return []; }
}

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port, path, method, headers: cookie ? { Cookie: cookie } : {} };
    if (body !== undefined) opts.headers['Content-Type'] = 'application/json';
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function draftRow(id, patch = {}, owner = 'user') {
  const other = owner === 'other';
  return {
    id,
    url: `https://x.com/example/status/${id}`,
    status: 'ready',
    config: { accountId: other ? 'acc_other' : 'acc_test', templateId: other ? 'tpl_other' : 'tpl_test' },
    scheduledAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    title: `标题${id}`,
    manualTitle: false,
    manualTime: null,
    images: [],
    selectedImages: [],
    credit: '作者：测试\nX：@test',
    body: `正文${id}`,
    variables: {},
    topic: null,
    error: '',
    createdAt: new Date().toISOString(),
    ...patch
  };
}

describe('batch draft routes', () => {
  let store;

  before(async () => {
    store = new FakeStore();
    const createRoutes = require('../src/routes');
    app = express();
    app.use(express.json());
    const loginThrottle = { check: () => ({ allowed: true, retryAfterSec: 0 }), fail() {}, succeed() {} };
    app.use('/api', createRoutes({ store, storage: {}, bili: new FakeBilibili(), scheduler: {}, cookieMonitor: {}, loginThrottle }));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port;
  });

  after(() => { if (server) server.close(); });

  it('GET 空草稿返回 revision=0 与空行', async () => {
    store.reset();
    const res = await request('GET', '/api/batch-draft', undefined, cookies.user);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { revision: 0, rows: [], config: {} });
  });

  it('PUT 可新建并按 revision 替换草稿', async () => {
    store.reset();
    const first = await request('PUT', '/api/batch-draft', { revision: 0, rows: [draftRow('a')], config: { prefix: '甲' } }, cookies.user);
    assert.equal(first.status, 200);
    assert.equal(first.body.revision, 1);
    assert.deepEqual(first.body.rows.map(row => row.id), ['a']);

    const second = await request('PUT', '/api/batch-draft', { revision: 1, rows: [draftRow('b')], config: { prefix: '乙' } }, cookies.user);
    assert.equal(second.status, 200);
    assert.equal(second.body.revision, 2);
    assert.deepEqual(second.body.rows.map(row => row.id), ['b']);

    const get = await request('GET', '/api/batch-draft', undefined, cookies.user);
    assert.equal(get.body.revision, 2);
    assert.deepEqual(get.body.rows.map(row => row.id), ['b']);
    assert.equal(get.body.config.prefix, '乙');
  });

  it('过期 revision 的 PUT 与 enqueue 均返回 409', async () => {
    store.reset();
    const created = await request('PUT', '/api/batch-draft', { revision: 0, rows: [draftRow('a')], config: {} }, cookies.user);
    assert.equal(created.body.revision, 1);

    const stalePut = await request('PUT', '/api/batch-draft', { revision: 0, rows: [], config: {} }, cookies.user);
    assert.equal(stalePut.status, 409);
    assert.equal(stalePut.body.revision, 1);

    const staleEnqueue = await request('POST', '/api/batch-draft/enqueue', { revision: 0, rowIds: ['a'] }, cookies.user);
    assert.equal(staleEnqueue.status, 409);
    assert.equal(staleEnqueue.body.revision, 1);
  });

  it('PUT 非法行返回 400 且不创建草稿', async () => {
    store.reset();
    const res = await request('PUT', '/api/batch-draft', {
      revision: 0,
      rows: [draftRow('bad', { status: 'queued' })],
      config: {}
    }, cookies.user);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /status 不合法/);
    assert.equal(store.getBatchDraft('usr_test'), null);
  });

  it('enqueue 部分成功：成功行删除，未就绪与无有效时间行保留并报错', async () => {
    store.reset();
    const rows = [
      draftRow('ok'),
      draftRow('parsing', { status: 'parsing', scheduledAt: '' }),
      draftRow('no-time', { scheduledAt: '' })
    ];
    const saved = await request('PUT', '/api/batch-draft', { revision: 0, rows, config: { prefix: '优香' } }, cookies.user);
    const res = await request('POST', '/api/batch-draft/enqueue', {
      revision: saved.body.revision,
      rowIds: rows.map(row => row.id)
    }, cookies.user);

    assert.equal(res.status, 200);
    assert.equal(res.body.created.length, 1);
    assert.equal(res.body.created[0].rowId, 'ok');
    assert.equal(res.body.failed.length, 2);
    assert.match(res.body.failed.find(item => item.rowId === 'parsing').error, /尚未就绪/);
    assert.match(res.body.failed.find(item => item.rowId === 'no-time').error, /没有有效的计划时间/);
    assert.deepEqual(res.body.rows.map(row => row.id).sort(), ['no-time', 'parsing']);
    assert.equal(store.data.jobs.length, 1);
    assert.equal(store.data.jobs[0].sourceDraftId, 'ok');
    assert.equal(store.flushCount, 1);
  });

  it('重复 enqueue 命中 sourceDraftId 时幂等，不重复创建任务', async () => {
    store.reset();
    const saved = await request('PUT', '/api/batch-draft', { revision: 0, rows: [draftRow('same')], config: {} }, cookies.user);
    store.data.jobs.push({ id: 'job_existing', userId: 'usr_test', sourceDraftId: 'same' });

    const res = await request('POST', '/api/batch-draft/enqueue', { revision: saved.body.revision, rowIds: ['same'] }, cookies.user);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.created, [{ rowId: 'same', id: 'job_existing' }]);
    assert.equal(store.data.jobs.length, 1);
    assert.deepEqual(res.body.rows, []);
  });

  it('提交他人草稿的 rowId 会被拒绝且不会删除自己的行', async () => {
    store.reset();
    const own = await request('PUT', '/api/batch-draft', { revision: 0, rows: [draftRow('own')], config: {} }, cookies.user);
    await request('PUT', '/api/batch-draft', { revision: 0, rows: [draftRow('other-row', {}, 'other')], config: {} }, cookies.other);

    const res = await request('POST', '/api/batch-draft/enqueue', { revision: own.body.revision, rowIds: ['other-row'] }, cookies.user);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.created, []);
    assert.deepEqual(res.body.failed, [{ rowId: 'other-row', error: '行不存在' }]);
    assert.deepEqual(res.body.rows.map(row => row.id), ['own']);
    assert.equal(store.data.jobs.length, 0);
  });
});
