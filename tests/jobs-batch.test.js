/* 测试：批量入队接口 */
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');

// 模拟环境
let app, server, port, cookies = {};

// 假 Store
class FakeStore {
  constructor() {
    this.data = {
      users: [{ id: 'usr_test', username: 'test', role: 'user', active: true, passwordHash: 'fake' }],
      accounts: [{ id: 'acc_test', userId: 'usr_test', name: '测试账号', sessdata: 'fake', bili_jct: 'fake' }],
      templates: [{ id: 'tpl_test', userId: 'usr_test', name: '测试模板', content: '{{content}}', variables: [{ key: 'content', type: 'textarea' }], maxImages: 3 }],
      images: [
        { key: 'img1', userId: 'usr_test', name: 'test1.jpg', url: '/uploads/img1' },
        { key: 'img2', userId: 'usr_test', name: 'test2.jpg', url: '/uploads/img2' }
      ],
      jobs: [],
      logs: [],
      libAccounts: []
    };
    this.saveCount = 0;
  }
  getUser(id) { return this.data.users.find(u => u.id === id); }
  getSession(token) {
    if (token === 'test-token') {
      return { user: this.data.users[0] };
    }
    return null;
  }
  listAccounts() { return this.data.accounts; }
  getAccount(id) { return this.data.accounts.find(a => a.id === id); }
  listTemplates() { return this.data.templates; }
  getTemplate(id) { return this.data.templates.find(t => t.id === id); }
  listImages() { return this.data.images; }
  listJobs() { return this.data.jobs; }
  listLibAccounts() { return this.data.libAccounts; }
  addJobSilent(job) { this.data.jobs.push(job); return job; }
  async addJob(job) { this.data.jobs.push(job); this.save(); return job; }
  addLogSilent(level, msg, extra) { this.data.logs.unshift({ time: new Date().toISOString(), level, message: msg, ...extra }); }
  async addLog(level, msg, extra) { this.addLogSilent(level, msg, extra); this.save(); }
  save() { this.saveCount++; }
}

// 假 Bilibili
class FakeBilibili {
  async searchTopic() { return []; }
  async searchMention() { return []; }
}

function request(method, path, body, cookie) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost',
      port,
      path,
      method,
      headers: cookie ? { Cookie: cookie } : {}
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
    }
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, headers: res.headers, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

describe('POST /api/jobs/batch', () => {
  let store;

  before(async () => {
    store = new FakeStore();
    const bili = new FakeBilibili();
    const createRoutes = require('../src/routes');
    app = express();
    app.use(express.json());
    
    app.use('/api', createRoutes({ store, storage: {}, bili, scheduler: {}, cookieMonitor: {} }));
    
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port;
    cookies.auth = 'sid=test-token';
  });

  after(() => {
    if (server) server.close();
  });

  it('未登录 → 401', async () => {
    const res = await request('POST', '/api/jobs/batch', { items: [] });
    assert.strictEqual(res.status, 401);
  });

  it('items 非数组 → 400', async () => {
    const res = await request('POST', '/api/jobs/batch', { items: 'not-array' }, cookies.auth);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /items 必须是数组/);
  });

  it('超过 50 条 → 400', async () => {
    const items = Array(51).fill({});
    const res = await request('POST', '/api/jobs/batch', { items }, cookies.auth);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /单次最多入队 50 条/);
  });

  it('空数组 → 200, created=[], failed=[], 一次 save', async () => {
    const beforeSave = store.saveCount;
    const res = await request('POST', '/api/jobs/batch', { items: [] }, cookies.auth);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.created, []);
    assert.deepStrictEqual(res.body.failed, []);
    assert.strictEqual(store.saveCount, beforeSave + 1);
  });

  it('单条成功 → created 包含 index/id/scheduledAt/title', async () => {
    store.data.jobs = [];
    const item = {
      templateId: 'tpl_test',
      accountId: 'acc_test',
      variables: { content: '测试正文' },
      images: [{ key: 'img1', name: 'test1.jpg', url: '/uploads/img1' }],
      title: '测试标题',
      type: '原创',
      mentions: [],
      scheduledAt: new Date(Date.now() + 3600000).toISOString()
    };
    const res = await request('POST', '/api/jobs/batch', { items: [item] }, cookies.auth);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created.length, 1);
    assert.strictEqual(res.body.failed.length, 0);
    assert.strictEqual(res.body.created[0].index, 0);
    assert.ok(res.body.created[0].id);
    assert.ok(res.body.created[0].scheduledAt);
    assert.strictEqual(res.body.created[0].title, '测试标题');
  });

  it('3 条全部成功 → created.length=3, 仅一次 save', async () => {
    store.data.jobs = [];
    const beforeSave = store.saveCount;
    const items = [1, 2, 3].map(i => ({
      templateId: 'tpl_test',
      accountId: 'acc_test',
      variables: { content: `正文${i}` },
      images: [],
      title: `标题${i}`,
      type: '原创',
      mentions: [],
      scheduledAt: new Date(Date.now() + 3600000).toISOString()
    }));
    const res = await request('POST', '/api/jobs/batch', { items }, cookies.auth);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created.length, 3);
    assert.strictEqual(res.body.failed.length, 0);
    assert.strictEqual(store.saveCount, beforeSave + 1);
    assert.strictEqual(store.data.jobs.length, 3);
  });

  it('首条失败，其余成功 → failed[0], created[1,2]', async () => {
    store.data.jobs = [];
    const items = [
      { templateId: 'nonexist', accountId: 'acc_test', variables: {}, images: [], scheduledAt: new Date().toISOString() },
      { templateId: 'tpl_test', accountId: 'acc_test', variables: { content: 'ok1' }, images: [], title: 'ok1', type: '原创', mentions: [], scheduledAt: new Date().toISOString() },
      { templateId: 'tpl_test', accountId: 'acc_test', variables: { content: 'ok2' }, images: [], title: 'ok2', type: '原创', mentions: [], scheduledAt: new Date().toISOString() }
    ];
    const res = await request('POST', '/api/jobs/batch', { items }, cookies.auth);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.failed.length, 1);
    assert.strictEqual(res.body.created.length, 2);
    assert.strictEqual(res.body.failed[0].index, 0);
    assert.ok(res.body.failed[0].error);
    assert.strictEqual(res.body.created[0].index, 1);
    assert.strictEqual(res.body.created[1].index, 2);
  });

  it('中间条目失败不影响后续 → index 正确映射', async () => {
    store.data.jobs = [];
    const items = [
      { templateId: 'tpl_test', accountId: 'acc_test', variables: { content: 'a' }, images: [], title: 'a', type: '原创', mentions: [], scheduledAt: new Date().toISOString() },
      { templateId: 'tpl_test', accountId: 'acc_test', variables: { content: 'b' }, images: [{ key: 'img999', name: 'bad' }], title: 'b', type: '原创', mentions: [], scheduledAt: new Date().toISOString() }, // 不存在的图片
      { templateId: 'tpl_test', accountId: 'acc_test', variables: { content: 'c' }, images: [], title: 'c', type: '原创', mentions: [], scheduledAt: new Date().toISOString() }
    ];
    const res = await request('POST', '/api/jobs/batch', { items }, cookies.auth);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created.length, 2);
    assert.strictEqual(res.body.failed.length, 1);
    assert.strictEqual(res.body.created[0].index, 0);
    assert.strictEqual(res.body.failed[0].index, 1);
    assert.strictEqual(res.body.created[1].index, 2);
  });

  it('图片超限 → 单条失败', async () => {
    store.data.jobs = [];
    const items = [{
      templateId: 'tpl_test',
      accountId: 'acc_test',
      variables: { content: 'test' },
      images: [{ key: 'img1' }, { key: 'img2' }, { key: 'img1' }, { key: 'img2' }], // 模板上限3张
      title: 'test',
      type: '原创',
      mentions: [],
      scheduledAt: new Date().toISOString()
    }];
    const res = await request('POST', '/api/jobs/batch', { items }, cookies.auth);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.failed.length, 1);
    assert.match(res.body.failed[0].error, /图片数量超出限制/);
  });
});
