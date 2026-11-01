/* 草稿 CRUD、用户隔离、直接发布与 ZIP 导入。 */
'use strict';
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const { buildZip } = require('../src/zip');
const { buildQueueCsv } = require('../src/queue-csv');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001ff0b1a2f0000000049454e44ae426082', 'hex');

class FakeStore {
  constructor() {
    this.data = {
      users: [{ id: 'u1', username: 'one', role: 'user', active: true }, { id: 'u2', username: 'two', role: 'user', active: true }, { id: 'admin', username: 'admin', role: 'admin', active: true }],
      accounts: [{ id: 'a1', userId: 'u1', name: '我的账号', sessdata: 'x' }, { id: 'a2', userId: 'u2', name: '他人账号', sessdata: 'x' }],
      templates: [{ id: 't1', userId: 'u1', name: '我的模板', content: '前缀{{content}}', maxImages: 2 }, { id: 't2', userId: 'u2', name: '他人模板', content: '{{content}}', maxImages: 2 }],
      images: [{ key: 'i1', userId: 'u1', name: '我的.png', url: '/uploads/i1' }, { key: 'i2', userId: 'u2', name: '他人.png', url: '/uploads/i2' }],
      drafts: [], jobs: [], folders: [], logs: [], libAccounts: []
    };
  }
  getUser(id) { return this.data.users.find(x => x.id === id); }
  getSession(token) { const user = this.getUser(token); return user ? { user } : null; }
  listAccounts() { return this.data.accounts; }
  getAccount(id) { return this.data.accounts.find(x => x.id === id); }
  listTemplates() { return this.data.templates; }
  getTemplate(id) { return this.data.templates.find(x => x.id === id); }
  listImages() { return this.data.images; }
  addImage(x) { this.data.images.push(x); return x; }
  deleteImage(key) { this.data.images = this.data.images.filter(x => x.key !== key); }
  listFolders() { return this.data.folders; }
  addFolder(x) { this.data.folders.push(x); return x; }
  listDrafts() { return this.data.drafts; }
  getDraft(id) { return this.data.drafts.find(x => x.id === id); }
  addDraft(x) { this.data.drafts.push(x); return x; }
  updateDraft(id, patch) { const x = this.getDraft(id); if (x) Object.assign(x, patch); return x; }
  deleteDraft(id) { this.data.drafts = this.data.drafts.filter(x => x.id !== id); }
  listJobs() { return this.data.jobs; }
  addJobSilent(x) { this.data.jobs.push(x); return x; }
  addJob(x) { return this.addJobSilent(x); }
  listLibAccounts() { return this.data.libAccounts; }
  getLibAccount(id) { return this.data.libAccounts.find(x => x.id === id); }
  addLogSilent() {}
  addLog() {}
  save() {}
}

let store, server, port;
function request(method, url, body, user = 'u1', headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body);
    const req = http.request({ hostname: 'localhost', port, path: '/api' + url, method,
      headers: { ...(user ? { Cookie: 'sid=' + user } : {}), ...(body && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(raw ? body : JSON.stringify(body));
    req.end();
  });
}
function input(extra = {}) {
  return { templateId: 't1', variables: { content: '正文' }, images: [{ key: 'i1' }], topic: { id: 8, name: '话题' }, title: '标题', type: '原创', slots: {}, ...extra };
}
async function create(extra) {
  const res = await request('POST', '/drafts', input(extra));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.draft;
}
function csvRow(extra = {}) {
  const x = { title: '导入标题', time: '不是合法时间', type: '原创', account: '不属于我且不存在的账号', template: '我的模板', text: '原样 {{content}} 正文', topic: '', images: '[]', ...extra };
  return [x.title, x.time, x.type, x.account, x.template, x.text, x.topic, x.images, '[]'];
}
function importZip(rows, images = {}, directories = []) {
  const zip = buildZip([
    { name: 'queue.csv', buffer: Buffer.from(buildQueueCsv(rows)) },
    ...directories.map(name => ({ name, buffer: Buffer.alloc(0) })),
    ...Object.entries(images).map(([name, buffer]) => ({ name: 'images/' + name, buffer }))
  ]);
  const boundary = '----drafts-test-boundary';
  const raw = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="drafts.zip"\r\nContent-Type: application/zip\r\n\r\n`), zip, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return request('POST', '/drafts/import', raw, 'u1', { 'Content-Type': 'multipart/form-data; boundary=' + boundary });
}

describe('草稿接口', () => {
  before(async () => {
    store = new FakeStore();
    let seq = 0;
    const files = new Map();
    const storage = {
      async put(buffer) { const key = 'import-' + ++seq; files.set(key, buffer); return { key, url: '/uploads/' + key }; },
      async delete(key) { files.delete(key); },
      async usage() { return null; }
    };
    const app = express();
    app.use(express.json());
    app.use('/api', require('../src/routes')({ store, storage, bili: { async searchTopic() { return []; }, async searchMention() { return []; } }, scheduler: {}, cookieMonitor: {}, loginThrottle: { check: () => ({ allowed: true }), fail() {}, succeed() {} } }));
    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    port = server.address().port;
  });
  after(() => server && server.close());
  beforeEach(() => { store.data.drafts = []; store.data.jobs = []; });

  it('全部六个接口均要求登录', async () => {
    for (const [method, path] of [['GET', '/drafts'], ['POST', '/drafts'], ['PATCH', '/drafts/x'], ['DELETE', '/drafts/x'], ['POST', '/drafts/x/publish'], ['POST', '/drafts/import']]) {
      assert.equal((await request(method, path, {}, null)).status, 401, method + ' ' + path);
    }
  });
  it('新增保留完整内容、渲染正文，不保存账号和计划时间', async () => {
    const draft = await create({ accountId: 'a2', scheduledAt: 'invalid' });
    assert.ok(draft.id);
    assert.equal(draft.userId, 'u1');
    assert.equal(draft.text, '前缀正文');
    assert.equal(draft.templateId, 't1');
    assert.equal(draft.templateName, '我的模板');
    assert.deepEqual(draft.variables, { content: '正文' });
    assert.equal(draft.images[0].key, 'i1');
    assert.deepEqual(draft.topic, { id: 8, name: '话题' });
    assert.equal(draft.title, '标题');
    assert.equal(draft.type, '原创');
    assert.deepEqual(draft.slots, {});
    assert.ok(draft.createdAt && draft.updatedAt);
    assert.equal(Object.hasOwn(draft, 'accountId'), false);
    assert.equal(Object.hasOwn(draft, 'scheduledAt'), false);
  });
  it('列表仅返回本人草稿（管理员也不可绕过），按更新时间倒序', async () => {
    store.data.drafts.push({ id: 'old', userId: 'u1', updatedAt: '2025-01-01' }, { id: 'foreign', userId: 'u2', updatedAt: '2027-01-01' }, { id: 'new', userId: 'u1', updatedAt: '2026-01-01' });
    assert.deepEqual((await request('GET', '/drafts')).body.drafts.map(x => x.id), ['new', 'old']);
    assert.deepEqual((await request('GET', '/drafts', null, 'admin')).body.drafts, []);
  });
  it('PATCH 无 variables 保留已渲染正文；给变量则重渲染', async () => {
    const draft = await create();
    let res = await request('PATCH', '/drafts/' + draft.id, { title: '新标题' });
    assert.equal(res.status, 200);
    assert.equal(res.body.draft.text, '前缀正文');
    assert.deepEqual(res.body.draft.variables, { content: '正文' });
    res = await request('PATCH', '/drafts/' + draft.id, { variables: { content: '修改正文' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.draft.text, '前缀修改正文');
  });
  it('删除本人草稿', async () => {
    const draft = await create();
    assert.deepEqual((await request('DELETE', '/drafts/' + draft.id)).body, { ok: true });
    assert.equal(store.data.drafts.length, 0);
  });
  it('越权编辑、删除、发布均 404/403，管理员也不例外', async () => {
    const draft = await create();
    for (const user of ['u2', 'admin']) {
      for (const [method, suffix] of [['PATCH', ''], ['DELETE', ''], ['POST', '/publish']]) {
        const res = await request(method, '/drafts/' + draft.id + suffix, { title: '窃取', accountId: 'a2' }, user);
        assert.ok([403, 404].includes(res.status), JSON.stringify(res));
      }
    }
    assert.equal(store.data.drafts.length, 1);
    assert.equal(store.data.jobs.length, 0);
  });
  it('不存在的草稿编辑、删除、发布返回 404', async () => {
    for (const [method, suffix] of [['PATCH', ''], ['DELETE', ''], ['POST', '/publish']]) assert.equal((await request(method, '/drafts/missing' + suffix, {})).status, 404);
  });
  it('拒绝他人模板、他人图片、超限配图与超长标题', async () => {
    for (const extra of [{ templateId: 't2' }, { images: [{ key: 'i2' }] }, { images: [{ key: 'i1' }, { key: 'i1' }, { key: 'i1' }] }, { title: '标'.repeat(21) }]) {
      const res = await request('POST', '/drafts', input(extra));
      assert.ok([400, 403, 404].includes(res.status), JSON.stringify(res));
    }
    assert.equal(store.data.drafts.length, 0);
  });
  it('PATCH 同样拒绝他人模板、图片、超限和空正文', async () => {
    const draft = await create();
    for (const patch of [{ templateId: 't2' }, { images: [{ key: 'i2' }] }, { images: [{ key: 'i1' }, { key: 'i1' }, { key: 'i1' }] }]) {
      const res = await request('PATCH', '/drafts/' + draft.id, patch);
      assert.ok([400, 403, 404].includes(res.status), JSON.stringify(res));
    }
    store.data.templates.push({ id: 'plain', userId: 'u1', name: '纯正文', content: '{{content}}', maxImages: 2 });
    const plain = await create({ templateId: 'plain' });
    assert.equal((await request('PATCH', '/drafts/' + plain.id, { variables: { content: '   ' } })).status, 400);
    assert.equal(store.getDraft(plain.id).text, '正文');
  });
  it('拒绝空正文，PATCH 失败不损坏原草稿', async () => {
    store.data.templates.push({ id: 'empty', userId: 'u1', name: '空', content: '{{content}}', maxImages: 2 });
    assert.equal((await request('POST', '/drafts', input({ templateId: 'empty', variables: {} }))).status, 400);
    const draft = await create();
    assert.equal((await request('PATCH', '/drafts/' + draft.id, { title: '标'.repeat(21) })).status, 400);
    assert.equal(store.getDraft(draft.id).title, '标题');
  });
  it('发布验证账号和时间，失败保留草稿', async () => {
    const draft = await create();
    for (const body of [{}, { accountId: 'a2' }, { accountId: 'missing' }, { accountId: 'a1', scheduledAt: 'not-a-date' }]) {
      assert.equal((await request('POST', '/drafts/' + draft.id + '/publish', body)).status, 400);
      assert.ok(store.getDraft(draft.id));
    }
    assert.equal(store.data.jobs.length, 0);
  });
  it('发布使用已渲染正文，生成 pending 任务后删除草稿', async () => {
    const draft = await create();
    store.getDraft(draft.id).text = '已渲染 {{不要再渲染}}\n 保留正文';
    const scheduledAt = new Date(Date.now() + 3600000).toISOString();
    const res = await request('POST', '/drafts/' + draft.id + '/publish', { accountId: 'a1', scheduledAt });
    assert.equal(res.status, 200);
    assert.equal(res.body.job.text, '已渲染 {{不要再渲染}}\n 保留正文');
    assert.equal(res.body.job.status, 'pending');
    assert.equal(res.body.job.accountId, 'a1');
    assert.equal(res.body.job.scheduledAt, scheduledAt);
    assert.equal(store.data.jobs.length, 1);
    assert.equal(store.getDraft(draft.id), undefined);
  });
  it('过去时间及空时间均归一为立即发布', async () => {
    for (const scheduledAt of ['', '2000-01-01T00:00:00Z']) {
      const draft = await create();
      const start = Date.now();
      const res = await request('POST', '/drafts/' + draft.id + '/publish', { accountId: 'a1', scheduledAt });
      assert.equal(res.status, 200);
      assert.ok(Date.parse(res.body.job.scheduledAt) >= start);
      assert.ok(Date.parse(res.body.job.scheduledAt) <= Date.now());
    }
  });
  it('ZIP 导入忽略非法/过去时间与不存在/他人账号，正文原样入库', async () => {
    const res = await importZip([csvRow(), csvRow({ time: 'iso:2000-01-01T00:00:00Z', account: '他人账号', title: '过去时间' })]);
    assert.equal(res.status, 200);
    assert.equal(res.body.created.length, 2);
    assert.deepEqual(res.body.failed, []);
    assert.deepEqual(res.body.skipped, []);
    assert.deepEqual(res.body.created.map(x => x.row), [2, 3]);
    assert.equal(store.data.jobs.length, 0);
    for (const draft of store.data.drafts) {
      assert.equal(draft.text, '原样 {{content}} 正文');
      assert.equal(draft.userId, 'u1');
      assert.equal(Object.hasOwn(draft, 'accountId'), false);
      assert.equal(Object.hasOwn(draft, 'scheduledAt'), false);
      assert.deepEqual(draft.slots, {});
    }
  });
  it('ZIP 目录条目兼容，图片入库到新导入文件夹且同图复用', async () => {
    const res = await importZip([csvRow({ images: '["a.png"]' }), csvRow({ images: '["a.png"]' })], { 'a.png': PNG }, ['images/', 'images/a/b/', '其他/空目录/']);
    assert.equal(res.status, 200);
    assert.equal(res.body.created.length, 2);
    assert.deepEqual(res.body.failed, []);
    const folder = store.data.folders.find(x => x.id === res.body.folderId);
    assert.ok(folder);
    assert.match(folder.name, /^导入 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const [one, two] = store.data.drafts;
    assert.equal(one.images[0].key, two.images[0].key);
    const image = store.data.images.find(x => x.key === one.images[0].key);
    assert.equal(image.folderId, folder.id);
    assert.equal(image.userId, 'u1');
  });
  it('ZIP 坏图魔数失败，草稿不落库', async () => {
    const res = await importZip([csvRow({ images: '["fake.png"]' })], { 'fake.png': Buffer.from('not really a PNG') });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /魔数|内容与扩展名/);
    assert.equal(store.data.drafts.length, 0);
  });
  it('ZIP 注释 skipped，缺图、空正文及长标题仅对应行失败', async () => {
    const res = await importZip([csvRow({ title: '# 注释' }), csvRow({ images: '["missing.png"]' }), csvRow({ text: '  ' }), csvRow({ title: '标'.repeat(21) }), csvRow({ title: '正常' })]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.skipped.map(x => x.row), [2]);
    assert.deepEqual(res.body.failed.map(x => x.row), [3, 4, 5]);
    assert.deepEqual(res.body.created.map(x => x.row), [6]);
    assert.equal(store.data.drafts.length, 1);
  });
  it('ZIP 超过 1000 行拒绝，复用导入行数限制', async () => {
    const res = await importZip(Array.from({ length: 1001 }, () => csvRow()));
    assert.equal(res.status, 400);
    assert.equal(store.data.drafts.length, 0);
  });
});
