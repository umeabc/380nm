/* 测试：POST /api/jobs/export、GET /api/jobs/import-template、POST /api/jobs/import */
'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('http');
const { buildZip, unzip } = require('../src/zip');
const { CSV_HEADERS, buildQueueCsv, jobToCsvCells } = require('../src/queue-csv');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // PNG 魔数（前 16 字节）
const FAKE_PNG = Buffer.concat([PNG, Buffer.alloc(16, 0)]);

// 1x1 最小 PNG（真魔数）
const MIN_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001' +
  '08060000001f15c4890000000d4944415478da63fcffff3f030005' +
  '0001ff0b1a2f0000000049454e44ae426082', 'hex');

let app, server, port, cookies = {}, store;

class FakeStore {
  constructor() {
    this.data = {
      users: [
        { id: 'usr_test', username: 'test', role: 'user', active: true, passwordHash: 'fake' },
        { id: 'usr_other', username: 'other', role: 'user', active: true, passwordHash: 'fake' },
        { id: 'usr_admin', username: 'admin', role: 'admin', active: true, passwordHash: 'fake' }
      ],
      sessions: {},
      folders: [],
      accounts: [
        { id: 'acc_test', userId: 'usr_test', name: '账号A', uname: '账号A', sessdata: 'x', bili_jct: 'x' },
        { id: 'acc_test2', userId: 'usr_test', name: '账号Ｂ', uname: '账号Ｂ', sessdata: 'x', bili_jct: 'x' },
        { id: 'acc_other', userId: 'usr_other', name: '账号B', uname: '账号B', sessdata: 'x', bili_jct: 'x' }
      ],
      templates: [
        { id: 'tpl_test', userId: 'usr_test', name: '模板X', content: '{{content}}', variables: [], maxImages: 2 }
      ],
      images: [
        { key: 'img1', userId: 'usr_test', folderId: null, name: '风景.jpg', url: '/uploads/img1', contentType: 'image/png' },
        { key: 'img2', userId: 'usr_test', folderId: null, name: '城市.png', url: '/uploads/img2', contentType: 'image/png' },
        { key: 'img_other', userId: 'usr_other', folderId: null, name: '别人的.jpg', url: '/uploads/img_other', contentType: 'image/png' },
        { key: 'img_lost', userId: 'usr_test', folderId: null, name: '丢的.jpg', url: '/uploads/img_lost', contentType: 'image/png' }
      ],
      jobs: [], logs: [], libAccounts: []
    };
    this.saveCount = 0;
    this.store = {}; // 模拟 storage 内容
  }
  getUser(id) { return this.data.users.find(u => u.id === id); }
  getSession(token) {
    const map = { 'tok-test': 'usr_test', 'tok-other': 'usr_other', 'tok-admin': 'usr_admin' };
    const uid = map[token];
    return uid ? { user: this.data.users.find(u => u.id === uid) } : null;
  }
  listFolders() { return this.data.folders; }
  addFolder(f) { this.data.folders.push(f); return f; }
  listAccounts() { return this.data.accounts; }
  getAccount(id) { return this.data.accounts.find(a => a.id === id); }
  listTemplates() { return this.data.templates; }
  getTemplate(id) { return this.data.templates.find(t => t.id === id); }
  listImages() { return this.data.images; }
  addImage(m) { this.data.images.unshift(m); return m; }
  async deleteImage(key) { this.data.images = this.data.images.filter(i => i.key !== key); }
  async addDraft(d) { (this.data.drafts ||= []).push(d); }
  listJobs() { return this.data.jobs; }
  getJob(id) { return this.data.jobs.find(j => j.id === id); }
  addJobSilent(j) { this.data.jobs.push(j); return j; }
  addLogSilent() {}
  async addLog() {}
  save() { this.saveCount++; }
}

function makeStorage() {
  const store = new FakeStore();
  const files = { img1: MIN_PNG, img2: MIN_PNG, img_other: MIN_PNG }; // img_lost 没有内容
  return {
    name: 'local',
    store,
    files,
    keys: new Map(),
    seq: 0,
    async put(buffer, name, mime) {
      const key = `new-${++this.seq}`;
      files[key] = buffer;
      this.keys.set(key, { name, mime });
      return { key, url: '/uploads/' + key };
    },
    async get(key) {
      if (!(key in files)) throw Object.assign(new Error('不存在'), { code: 'ENOENT' });
      return { buffer: files[key], contentType: 'application/octet-stream' };
    },
    async delete(key) { delete files[key]; },
    async usage() { return null; }
  };
}

function request(method, path, body, cookie, extraHeaders = {}, raw = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'localhost', port, path, method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders } };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = buf;
        try { if (!raw) parsed = JSON.parse(buf.toString()); } catch (e) { /* keep buffer */ }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    if (raw) req.write(raw);
    req.end();
  });
}

function multipart(fields, files) {
  // files: [{ field, filename, buffer }]
  const boundary = '----testboundary' + Date.now();
  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  const chunks = [Buffer.from(parts.join(''))];
  for (const f of files || []) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: application/zip\r\n\r\n`));
    chunks.push(f.buffer, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

function mkJob(userId, over = {}) {
  return Object.assign({
    id: 'job_' + Math.random().toString(36).slice(2, 8),
    userId,
    templateId: 'tpl_test', templateName: '模板X',
    accountId: 'acc_test', accountName: '账号A',
    text: '正文', images: [], topic: null, title: '标题',
    mentions: [], type: '原创', slots: {},
    scheduledAt: new Date(Date.now() + 3600000).toISOString(),
    status: 'pending', attempts: 0, lastError: null, publishedAt: null,
    dynamicId: '', dynamicUrl: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }, over);
}

describe('POST /api/jobs/export 与 GET /api/jobs/import-template', () => {
  let storage;
  before(async () => {
    storage = makeStorage();
    store = storage.store;
    app = express();
    app.use(express.json({ limit: '10mb' }));
    const createRoutes = require('../src/routes');
    const loginThrottle = { check: () => ({ allowed: true, retryAfterSec: 0 }), fail() {}, succeed() {} };
    app.use('/api', createRoutes({ store, storage, bili: { async searchTopic() { return []; }, async searchMention() { return []; } }, scheduler: {}, cookieMonitor: {}, loginThrottle }));
    server = app.listen(0);
    await new Promise(r => server.once('listening', r));
    port = server.address().port;
    cookies.test = 'sid=tok-test';
    cookies.other = 'sid=tok-other';
    cookies.admin = 'sid=tok-admin';
    globalThis.__storage = storage;
  });
  after(() => { if (server) server.close(); });

  it('未登录 → 401', async () => {
    const res = await request('POST', '/api/jobs/export', JSON.stringify({ ids: ['x'] }));
    assert.strictEqual(res.status, 401);
  });

  it('导出 zip 内容与文件名清洗', async () => {
    store.data.jobs = [
      mkJob('usr_test', {
        id: 'j1', title: 't1',
        images: [
          { key: 'img1', name: '风景/坏:名?.jpg', url: '/uploads/img1' },
          { key: 'img2', name: '城市.png', url: '/uploads/img2' }
        ],
        text: '含,逗号\n含"引号"', topic: { id: 5, name: '话题T' },
        mentions: [{ uid: '1', name: 'm' }]
      })
    ];
    const res = await request('POST', '/api/jobs/export',
      JSON.stringify({ ids: ['j1'] }), cookies.test,
      { 'Content-Type': 'application/json' }, null);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'application/zip');
    assert.match(res.headers['content-disposition'], /attachment; filename="380nm-queue-\d{8}-\d{4}\.zip"/);
    const entries = unzip(res.buf);
    const names = entries.map(e => e.name);
    assert.ok(names.includes('queue.csv'));
    assert.ok(names.includes('README.txt'));
    assert.ok(names.includes('images/风景_坏_名_.jpg'));
    assert.ok(names.includes('images/城市.png'));
    // CSV 带 BOM、表头正确、正文保序引用清洗后的名字
    const csv = entries.find(e => e.name === 'queue.csv').buffer;
    assert.deepStrictEqual([...csv.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
    const { parseQueueCsv } = require('../src/queue-csv');
    const rows = parseQueueCsv(csv.toString('utf8'));
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].text, '含,逗号\n含"引号"');
    assert.deepStrictEqual(JSON.parse(rows[0].images), ['风景_坏_名_.jpg', '城市.png']);
    assert.deepStrictEqual(JSON.parse(rows[0].mentions), [{ uid: '1', name: 'm' }]);
    assert.match(rows[0].scheduledAt, /^iso:/);
  });

  it('重名加 (2)、同 key 复用同一文件名', async () => {
    store.data.jobs = [
      mkJob('usr_test', { id: 'ja', title: 'a', images: [{ key: 'img1', name: '同.jpg', url: '' }] }),
      mkJob('usr_test', { id: 'jb', title: 'b', images: [
        { key: 'img1', name: '同.jpg', url: '' }, { key: 'img2', name: '同.jpg', url: '' }] })
    ];
    const res = await request('POST', '/api/jobs/export',
      JSON.stringify({ ids: ['ja', 'jb'] }), cookies.test, { 'Content-Type': 'application/json' });
    assert.strictEqual(res.status, 200);
    const names = unzip(res.buf).map(e => e.name);
    assert.ok(names.includes('images/同.jpg'));
    assert.ok(names.includes('images/同(2).jpg'));
    // 同 key 只一份
    assert.strictEqual(names.filter(n => n === 'images/同.jpg').length, 1);
    const { parseQueueCsv } = require('../src/queue-csv');
    const csvEntry = unzip(res.buf).find(e => e.name === 'queue.csv');
    const rows = parseQueueCsv(csvEntry.buffer.toString('utf8'));
    assert.deepStrictEqual(JSON.parse(rows[0].images), ['同.jpg']);
    assert.deepStrictEqual(JSON.parse(rows[1].images), ['同.jpg', '同(2).jpg']);
  });

  it('图片缺失 → 422 且不生成 zip', async () => {
    store.data.jobs = [mkJob('usr_test', {
      id: 'jlost', title: 'x', images: [{ key: 'img_lost', name: '丢的.jpg', url: '' }]
    })];
    const res = await request('POST', '/api/jobs/export',
      JSON.stringify({ ids: ['jlost'] }), cookies.test, { 'Content-Type': 'application/json' });
    assert.strictEqual(res.status, 422);
    assert.match(res.body.error, /丢失|读取失败/);
  });

  it('越权（他人任务，非管理员）→ 404', async () => {
    store.data.jobs = [mkJob('usr_other', { id: 'jother', title: 'x' })];
    const res = await request('POST', '/api/jobs/export',
      JSON.stringify({ ids: ['jother'] }), cookies.test, { 'Content-Type': 'application/json' });
    assert.strictEqual(res.status, 404);
  });

  it('管理员 scope=all 可导他人任务，但图片必须属于该任务的 userId → 422', async () => {
    store.data.jobs = [mkJob('usr_test', {
      id: 'jborrow', title: 'x', images: [{ key: 'img_other', name: '别人的.jpg', url: '' }]
    })];
    const res = await request('POST', '/api/jobs/export?scope=all',
      JSON.stringify({ ids: ['jborrow'] }), cookies.admin, { 'Content-Type': 'application/json' });
    assert.strictEqual(res.status, 422);
    assert.match(res.body.error, /归属/);
    // 正常他人任务可导
    store.data.jobs = [mkJob('usr_other', { id: 'jok', title: 'x' })];
    const ok = await request('POST', '/api/jobs/export?scope=all',
      JSON.stringify({ ids: ['jok'] }), cookies.admin, { 'Content-Type': 'application/json' });
    assert.strictEqual(ok.status, 200);
  });

  it('超 32000 字符正文 → 422 并说明', async () => {
    store.data.jobs = [mkJob('usr_test', { id: 'jlong', title: 'x', text: 'y'.repeat(32001) })];
    const res = await request('POST', '/api/jobs/export',
      JSON.stringify({ ids: ['jlong'] }), cookies.test, { 'Content-Type': 'application/json' });
    assert.strictEqual(res.status, 422);
    assert.match(res.body.error, /32000/);
  });
  it('返回 zip：queue.csv（BOM+示例+# 说明行）、images/ 占位、README.txt', async () => {
    const generatedAt = Date.now();
    const res = await request('GET', '/api/jobs/import-template', null, cookies.test);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'application/zip');
    const entries = unzip(res.buf);
    const names = entries.map(e => e.name);
    assert.ok(names.includes('queue.csv'));
    assert.ok(names.includes('README.txt'));
    assert.ok(names.includes('images/'));
    const csv = entries.find(e => e.name === 'queue.csv').buffer;
    assert.deepStrictEqual([...csv.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
    const text = csv.toString('utf8');
    assert.match(text, /\r\n# 说明行/); // 表头行后第一行是 # 说明
    const { parseQueueCsv } = require('../src/queue-csv');
    const rows = parseQueueCsv(text);
    assert.ok(rows.length >= 1);
    assert.ok(rows[0].skipped); // # 说明行
    const sample = rows.find(row => !row.skipped);
    assert.match(sample.scheduledAt, /^iso:\d{4}-\d{2}-\d{2}T10:00:00\+08:00$/);
    assert.ok(Date.parse(sample.scheduledAt.slice(4)) > generatedAt);
    const imported = await postImport(res.buf);
    assert.strictEqual(imported.status, 200);
    assert.strictEqual(imported.body.failed.length, 1);
    assert.strictEqual(imported.body.failed[0].row, 8);
    assert.match(imported.body.failed[0].reason, /未找到账号/);
    assert.doesNotMatch(imported.body.failed[0].reason, /Cannot read properties|TypeError/);
  });


  it('v2.0.9 fixed optional columns and declared label deduplication', async () => {
    const { parseCsv } = require('../src/queue-csv');
    for (const vars of [[], [{ key: 'title', label: '作品名' }, { key: 'origAuthor', label: '作者名' }, { key: 'handle', label: '社交号' }]]) {
      const template = { id: 'fixed-cols', name: '固定列', userId: 'usr_test', content: '正文', variables: vars };
      store.data.templates.push(template);
      try {
        for (const query of ['', '?templateId=fixed-cols']) {
          const result = await request('GET', '/api/jobs/import-template' + query, null, cookies.test);
          const header = parseCsv(unzip(result.buf).find(e => e.name === 'queue.csv').buffer.toString('utf8').replace(/^\uFEFF/, ''))[0];
          const labels = query && vars.length ? vars.map(v => v.label) : ['标题', '原作者', 'X号'];
          for (const label of labels) assert.equal(header.filter(h => h === label).length, 1);
          if (query && vars.length) {
            assert.deepEqual(header.slice(1, 4), labels);
            for (const label of ['标题', '原作者', 'X号']) assert.ok(!header.includes(label));
          }
        }
      } finally { store.data.templates = store.data.templates.filter(t => t !== template); }
    }
  });

  it('v2.0.9 queue and draft imports: labels, keys, blanks, handle normalization and title limit', async () => {
    const { csvRow } = require('../src/queue-csv');
    const template = { id: 'optional-cols', name: '可空列', userId: 'usr_test', content: '正文 {{title}}/{{origAuthor}}/{{handle}}', variables: [
      { key: 'title', label: '作品名' }, { key: 'origAuthor', label: '作者名' }, { key: 'handle', label: '社交号' }
    ] };
    store.data.templates.push(template);
    try {
      for (const endpoint of ['/api/jobs/import', '/api/drafts/import']) {
        for (const labels of [['标题', '原作者', 'X号'], ['title', 'origAuthor', 'handle'], ['作品名', '作者名', '社交号']]) {
          for (const values of [['', '', ''], ['作品', '作者', '@@artist'], ['长'.repeat(21), '', '']]) {
            const csv = csvRow(['模板', ...labels, '计划时间', '配图', '提及']) + csvRow([template.name, ...values, 'iso:' + new Date(Date.now() + 86400000).toISOString(), '[]', '[]']);
            const mp = multipart({}, [{ field: 'file', filename: 'import.zip', buffer: buildImportZip(csv) }]);
            const result = await request('POST', endpoint, mp.body, cookies.test, mp.headers);
            assert.equal(result.status, 200);
            if (values[0].length > 20) { assert.match(result.body.failed[0].reason, /20/); continue; }
            assert.deepEqual(result.body.failed, []);
            const item = [...store.data.jobs, ...(store.data.drafts || [])].find(j => j.id === result.body.created[0].id);
            assert.equal(item.title, values[0]);
            assert.equal(item.variables.origAuthor, values[1]);
            assert.equal(item.variables.handle, values[2] ? 'artist' : '');
            assert.ok(!item.text.includes('@'));
          }
        }
        // Generic CSV retains its original body while storing the optional variables.
        const csv = csvRow([...CSV_HEADERS, '原作者', 'X号']) + csvRow([...rowCells({ title: '' }), '作者', '@generic']);
        const mp = multipart({}, [{ field: 'file', filename: 'import.zip', buffer: buildImportZip(csv) }]);
        const result = await request('POST', endpoint, mp.body, cookies.test, mp.headers);
        assert.deepEqual(result.body.failed, []);
        const item = [...store.data.jobs, ...(store.data.drafts || [])].find(j => j.id === result.body.created[0].id);
        assert.equal(item.variables.handle, 'generic');
        assert.equal(item.variables.origAuthor, '作者');
        assert.equal(item.title, '');
        assert.equal(item.text, '导入正文');
      }
    } finally { store.data.templates = store.data.templates.filter(t => t !== template); }
  });

  function csvLines(rows) {
    return buildQueueCsv(rows);
  }

  it('v2.0.9 undeclared optional variables are stored for both import destinations', async () => {
    const { csvRow } = require('../src/queue-csv');
    const template = { id: 'no-optional-vars', name: '无变量', userId: 'usr_test', content: '固定正文', variables: [] };
    store.data.templates.push(template);
    try {
      for (const endpoint of ['/api/jobs/import', '/api/drafts/import']) {
        for (const values of [['', '', ''], ['', '作者', '@artist']]) {
          const csv = csvRow(['模板', '标题', '原作者', 'X号', '计划时间', '配图', '提及']) + csvRow([template.name, ...values, 'iso:' + new Date(Date.now() + 86400000).toISOString(), '[]', '[]']);
          const mp = multipart({}, [{ field: 'file', filename: 'import.zip', buffer: buildImportZip(csv) }]);
          const result = await request('POST', endpoint, mp.body, cookies.test, mp.headers);
          assert.deepEqual(result.body.failed, []);
          const item = [...store.data.jobs, ...(store.data.drafts || [])].find(j => j.id === result.body.created[0].id);
          assert.equal(item.title, '');
          assert.equal(item.variables.origAuthor, values[1]);
          assert.equal(item.variables.handle, values[2] ? 'artist' : '');
          assert.equal(item.text, '固定正文');
        }
      }
    } finally { store.data.templates = store.data.templates.filter(t => t !== template); }
  });

  it('所有内置模板实际下载的 CSV 表头两两不同，包含正文和署名变量', async () => {
    const templates = require('../src/templates').DEFAULT_TEMPLATES().map(t => ({ ...t, userId: 'usr_test' }));
    store.data.templates.push(...templates);
    try {
      const headers = [];
      for (const template of templates) {
        const response = await request('GET', '/api/jobs/import-template?templateId=' + template.id, null, cookies.test);
        assert.strictEqual(response.headers['cache-control'], 'no-store, max-age=0');
        const header = unzip(response.buf).find(e => e.name === 'queue.csv').buffer.toString('utf8').split('\r\n')[0];
        headers.push(header);
        if (template.id.startsWith('tpl_batch')) {
          assert.match(header, /作者说明/);
          assert.match(header, /author,handle/);
          assert.doesNotMatch(header, /sourceUrl/);
        }
        assert.doesNotMatch(header, /staff\d|translator|typesetter/);
      }
      // 当前六份没有正文、署名和变量完全一致的模板，无须跳过。
      assert.strictEqual(new Set(headers).size, templates.length);
    } finally { store.data.templates = store.data.templates.filter(t => !templates.includes(t)); }
  });

  it('2.0.14 手动加入 sourceUrl 的批量署名仍导出作品链接变量', async () => {
    const template = {
      ...require('../src/templates').DEFAULT_BATCH_TEMPLATES()[0],
      id: 'manual-source-url', userId: 'usr_test',
      signatureFormat: '作者：{{author}}\n账号：{{handle}}\n作品：{{sourceUrl}}'
    };
    store.data.templates.push(template);
    try {
      const response = await request('GET', '/api/jobs/import-template?templateId=' + template.id, null, cookies.test);
      assert.strictEqual(response.status, 200);
      const header = unzip(response.buf).find(e => e.name === 'queue.csv').buffer.toString('utf8').split('\r\n')[0];
      assert.match(header, /author,handle,sourceUrl/);
    } finally { store.data.templates = store.data.templates.filter(t => t !== template); }
  });

  it('作者说明和原作者独立保存，人员按规范化名称有序匹配，缺失或歧义导致行失败', async () => {
    const template = { id: 'staff-import', userId: 'usr_test', name: '人员导入', content: '{{credit}}/{{origAuthor}}/{{staff1}}/{{staff2}}', variables: [{ key: 'origAuthor', label: '原作者' }] };
    store.data.templates.push(template);
    store.listLibAccounts = () => store.data.libAccounts;
    const people = [{ id: 'person-a', userId: 'usr_test', name: 'Ａlice', handle: 'alice' }, { id: 'person-b', userId: 'usr_test', name: 'Bob', handle: 'bob' }];
    store.data.libAccounts.push(...people);
    const { csvRow } = require('../src/queue-csv');
    const make = names => buildImportZip(csvRow(['模板', '作者说明', '原作者', '参与人员', '标题', '计划时间', '配图', '提及']) + csvRow([template.name, '说明', '原作者名', names, '标题', 'iso:' + new Date(Date.now() + 86400000).toISOString(), '[]', '[]']));
    try {
      const result = await postImport(make(' alice ; BOB '));
      assert.deepStrictEqual(result.body.failed, []);
      const job = store.getJob(result.body.created[0].id);
      assert.strictEqual(job.text, '说明/原作者名/@alice/@bob');
      assert.deepStrictEqual(job.staff.map(p => p.id), ['person-a', 'person-b']);
      assert.strictEqual(job.variables.credit, '说明');
      assert.strictEqual(job.variables.origAuthor, '原作者名');
      assert.match((await postImport(make('Nobody'))).body.failed[0].reason, /未找到参与人员.*Nobody/);
      store.data.libAccounts.push({ ...people[0], id: 'duplicate', name: 'alice' });
      assert.match((await postImport(make('Alice'))).body.failed[0].reason, /参与人员.*多个/);
      assert.match((await postImport(make('Bob; bob'))).body.failed[0].reason, /参与人员不能重复/);
    } finally {
      store.data.templates = store.data.templates.filter(t => t !== template);
      store.data.libAccounts = [];
    }
  });

  it('正文不同但变量列相同的自定义模板也能区分表头', async () => {
    const templates = ['甲{{body}}', '乙{{body}}'].map((content, i) => ({ id: 'collision-' + i, name: '碰撞' + i, content, variables: [], userId: 'usr_test' }));
    store.data.templates.push(...templates);
    try {
      const headers = [];
      for (const template of templates) {
        const response = await request('GET', '/api/jobs/import-template?templateId=' + template.id, null, cookies.test);
        headers.push(unzip(response.buf).find(e => e.name === 'queue.csv').buffer.toString('utf8').split('\r\n')[0]);
      }
      assert.notStrictEqual(headers[0], headers[1]);
      assert.match(headers[0], /模板标识:collision-0/);
    } finally { store.data.templates = store.data.templates.filter(t => !templates.includes(t)); }
  });

  it('所选模板下载所有 label，变量导入识别 label/key 和规范化模板名称', async () => {
    const template = { id: 'variable-template', userId: 'usr_test', name: 'Morning Ａ', content: '{{date}}/{{body}}/{{OrigAuthor}}', maxImages: 2,
      variables: [{ key: 'date', label: '日期' }, { key: 'body', label: '正文', type: 'textarea' }, { key: 'origAuthor', label: '原作者' }] };
    store.data.templates.push(template);
    try {
      const downloaded = await request('GET', '/api/jobs/import-template?templateId=variable-template', null, cookies.test);
      assert.strictEqual(downloaded.status, 200);
      const text = unzip(downloaded.buf).find(e => e.name === 'queue.csv').buffer.toString('utf8').replace(/^\uFEFF/, '');
      assert.strictEqual(text.split('\r\n')[0], '模板,日期,正文,原作者,标题,X号,计划时间,配图,提及');
      assert.match(text, /Morning Ａ/);
      assert.match(text, /T10:00:00\+08:00/);
      const { csvRow } = require('../src/queue-csv');
      const time = 'iso:' + new Date(Date.now() + 86400000).toISOString();
      const csv = csvRow(['模板', '日期', 'body', '原作者', '标题', '计划时间', '配图', '提及']) + csvRow([' morning a ', '明日', '早报', '作者', '日报', time, '[]', '[]']);
      const result = await postImport(buildImportZip(csv));
      assert.strictEqual(result.status, 200);
      assert.deepStrictEqual(result.body.failed, []);
      const job = store.getJob(result.body.created[0].id);
      assert.strictEqual(job.text, '明日/早报/作者');
      assert.deepStrictEqual(job.variables, { date: '明日', body: '早报', origAuthor: '作者', handle: '' });
      assert.strictEqual(job.accountId, 'acc_test');
      template.signatureFormat = 'By {{OrigAuthor}}';
      const originalContent = template.content;
      template.content = '{{credit}}/' + originalContent;
      const signed = await postImport(buildImportZip(csv));
      assert.deepStrictEqual(signed.body.failed, []);
      assert.strictEqual(store.getJob(signed.body.created[0].id).text, 'By ' + job.variables.origAuthor + '/' + job.text);
      template.content = originalContent;
      delete template.signatureFormat;

      store.data.templates.push({ ...template, id: 'ambiguous', name: 'morning a' });
      const ambiguous = await postImport(buildImportZip(csv));
      assert.match(ambiguous.body.failed[0].reason, /模板.*多个/);
      const missing = await postImport(buildImportZip(csv.replace(' morning a ', '不存在')));
      assert.match(missing.body.failed[0].reason, /未找到模板/);
      const denied = await request('GET', '/api/jobs/import-template?templateId=variable-template', null, cookies.other);
      assert.strictEqual(denied.status, 404);
    } finally { store.data.templates = store.data.templates.filter(t => !['variable-template', 'ambiguous'].includes(t.id)); }
  });
  function buildImportZip(csvText, images) {
    const entries = [{ name: 'queue.csv', buffer: Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(csvText, 'utf8')]) }];
    for (const [name, buf] of Object.entries(images || {})) {
      entries.push({ name: 'images/' + name, buffer: buf });
    }
    return buildZip(entries);
  }
  function postImport(zip, cookie = cookies.test) {
    const mp = multipart({}, [{ field: 'file', filename: 'queue.zip', buffer: zip }]);
    return request('POST', '/api/jobs/import', mp.body, cookie, mp.headers, null);
  }
  function rowCells(over = {}) {
    return jobToCsvCells(Object.assign({
      title: '导入标题', scheduledAt: new Date(Date.now() + 86400000).toISOString(),
      type: '原创', accountName: '账号A', templateName: '模板X',
      text: '导入正文', topic: null, mentions: []
    }, over), over.__imgs || []);
  }

  it('导入成功：任务创建、图片入库、文件夹创建', async () => {
    store.data.jobs = [];
    const csv = csvLines([
      rowCells({ __imgs: ['a.png'] }),
      rowCells({ title: '第二条', __imgs: ['a.png', 'b.png'] })
    ]);
    const zip = buildImportZip(csv, { 'a.png': MIN_PNG, 'b.png': MIN_PNG });
    const res = await postImport(zip);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created.length, 2);
    assert.strictEqual(res.body.failed.length, 0);
    assert.ok(res.body.folderId);
    // 任务字段
    const job = store.data.jobs.find(j => j.id === res.body.created[0].id);
    assert.strictEqual(job.text, '导入正文');
    assert.strictEqual(job.status, 'pending');
    assert.strictEqual(job.templateId, 'tpl_test');
    assert.strictEqual(job.accountId, 'acc_test');
    assert.deepStrictEqual(job.slots, {});
    assert.strictEqual(job.images.length, 1);
    // 图片入库到新文件夹
    const img = store.data.images.find(i => i.key === job.images[0].key);
    assert.strictEqual(img.folderId, res.body.folderId);
    assert.strictEqual(img.name, 'a.png');
    // 同 zip 内 a.png 只存一次
    const j2 = store.data.jobs.find(j => j.id === res.body.created[1].id);
    assert.strictEqual(j2.images[0].key, job.images[0].key);
  });

  it('zip 带 images/ 目录占位及任意层级目录条目 → 导入成功', async () => {
    const zip = buildZip([
      { name: 'queue.csv', buffer: Buffer.from(csvLines([rowCells({ __imgs: ['a.png'] })])) },
      { name: 'images/', buffer: Buffer.alloc(0) },
      { name: 'images/a/b/', buffer: Buffer.alloc(0) },
      { name: '其他/空目录/', buffer: Buffer.alloc(0) },
      { name: 'images/a.png', buffer: MIN_PNG }
    ]);
    const res = await postImport(zip);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created.length, 1);
    assert.deepStrictEqual(res.body.failed, []);
    assert.deepStrictEqual(res.body.skipped, []);
  });

  it('macOS 资源叉、隐藏文件及根 Windows 元数据 → 静默忽略', async () => {
    const before = store.data.images.length;
    const ignored = [
      '__MACOSX/', '__MACOSX/images/', '__MACOSX/images/._a.png',
      '__MACOSX/metadata.txt', '.DS_Store', 'images/.DS_Store',
      'images/._a.png', '.hidden/nested.txt', 'images/.hidden/nested.txt',
      'Thumbs.db', 'desktop.ini', 'THUMBS.DB', 'DESKTOP.INI'
    ];
    const zip = buildZip([
      { name: 'queue.csv', buffer: Buffer.from(csvLines([rowCells()])) },
      ...ignored.map(name => ({ name, buffer: name.endsWith('/') ? Buffer.alloc(0) : Buffer.from('metadata') }))
    ]);
    const res = await postImport(zip);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created.length, 1);
    assert.deepStrictEqual(res.body.failed, []);
    assert.deepStrictEqual(res.body.skipped, []);
    assert.strictEqual(store.data.images.length, before);
    assert.deepStrictEqual(Object.keys(res.body).sort(), ['created', 'failed', 'folderId', 'skipped']);
  });

  it('images/a/b.jpg 两层图片 → 400', async () => {
    const zip = buildImportZip(csvLines([rowCells()]), { 'a/b.jpg': MIN_PNG });
    const res = await postImport(zip);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /不允许的条目: images\/a\/b\.jpg/);
  });

  it('Windows 元数据仅忽略根目录，images/ 下仍做扩展名校验', async () => {
    for (const name of ['Thumbs.db', 'desktop.ini']) {
      const res = await postImport(buildImportZip(csvLines([rowCells()]), { [name]: Buffer.from('metadata') }));
      assert.strictEqual(res.status, 400);
      assert.match(res.body.error, /扩展名不在支持范围/);
    }
  });

  it('大小写不同的两个根 queue.csv → 400', async () => {
    const csv = Buffer.from(csvLines([rowCells()]));
    const res = await postImport(buildZip([
      { name: 'queue.csv', buffer: csv },
      { name: 'QUEUE.CSV', buffer: csv },
      { name: 'images/', buffer: Buffer.alloc(0) }
    ]));
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /必须有且仅有一个 queue\.csv/);
  });

  it('模板匹配失败及缺失图片均只返回一条明确失败原因', async () => {
    for (const [over, reason] of [
      [{ templateName: '不存在的模板' }, /未找到模板/],
      [{ __imgs: ['示例图片.jpg'] }, /配图 示例图片\.jpg 不在 images\/ 目录中/],
      [{ topic: { name: '话题' }, __imgs: [] }, null]
    ]) {
      const res = await postImport(buildImportZip(csvLines([rowCells(over)])));
      assert.strictEqual(res.status, 200);
      if (reason) {
        assert.strictEqual(res.body.failed.length, 1);
        assert.match(res.body.failed[0].reason, reason);
      } else {
        assert.strictEqual(res.body.created.length, 1); // 空配图数组合法
      }
    }
  });

  it('内部异常仅返回通用行错误并写服务端日志', async () => {
    const st = globalThis.__storage;
    const originalPut = st.put;
    const originalError = console.error;
    const errors = [];
    st.put = async () => { throw new TypeError('internal-secret'); };
    console.error = (...args) => errors.push(args);
    try {
      const res = await postImport(buildImportZip(csvLines([rowCells({ __imgs: ['a.png'] })]), { 'a.png': MIN_PNG }));
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(res.body.failed, [{ row: 2, reason: '导入失败（第 2 行）' }]);
      assert.doesNotMatch(JSON.stringify(res.body), /internal-secret|TypeError/);
      assert.strictEqual(errors.length, 1);
      assert.ok(errors[0][1] instanceof TypeError);
    } finally {
      st.put = originalPut;
      console.error = originalError;
    }
  });

  it('部分失败：失败行不建任务且其新增图片被清理', async () => {
    store.data.jobs = [];
    const before = store.data.images.length;
    const csv = csvLines([
      rowCells({ title: '好行', __imgs: ['ok.png'] }),
      rowCells({ accountName: '不存在的账号', __imgs: ['bad.png'] })
    ]);
    const zip = buildImportZip(csv, { 'ok.png': MIN_PNG, 'bad.png': MIN_PNG });
    const res = await postImport(zip);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.created.length, 1);
    assert.strictEqual(res.body.failed.length, 1);
    assert.strictEqual(res.body.failed[0].row, 3);
    assert.match(res.body.failed[0].reason, /账号/);
    // bad.png 的入库记录被回滚（库里只有 ok.png 新增）
    assert.strictEqual(store.data.images.filter(i => i.name === 'bad.png').length, 0);
    assert.ok(store.data.images.some(i => i.name === 'ok.png'));
    assert.strictEqual(store.data.jobs.length, 1);
  });

  it('过去时间 → 该行失败', async () => {
    store.data.jobs = [];
    const past = new Date(Date.now() - 3600000);
    const csv = csvLines([rowCells({ scheduledAt: past.toISOString(), __imgs: [] })]);
    const res = await postImport(buildImportZip(csv, {}));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.failed.length, 1);
    assert.match(res.body.failed[0].reason, /过去时间/);
    assert.strictEqual(store.data.jobs.length, 0);
  });

  it('账号名歧义（NFKC/大小写等同）→ 该行失败', async () => {
    store.data.jobs = [];
    // 临时加一个与 '账号A' 在 NFKC+lower 下相同的账号 → 歧义
    store.data.accounts.push({ id: 'acc_dup', userId: 'usr_test', name: '账号Ａ', uname: '账号Ａ', sessdata: 'x', bili_jct: 'x' });
    const csv = csvLines([rowCells({ accountName: '账号Ａ', __imgs: [] })]);
    const res = await postImport(buildImportZip(csv, {}));
    store.data.accounts = store.data.accounts.filter(a => a.id !== 'acc_dup');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.failed.length, 1);
    assert.match(res.body.failed[0].reason, /歧义|匹配到多个/);
  });

  it('缺 queue.csv → 400；根下多余文件 → 400；缺列 → 400', async () => {
    const noCsv = buildZip([{ name: 'README.txt', buffer: Buffer.from('x') }]);
    assert.strictEqual((await postImport(noCsv)).status, 400);
    const extra = buildImportZip('标题\nx', { 'a.png': MIN_PNG });
    const extra2 = buildZip([
      { name: 'queue.csv', buffer: Buffer.from('\uFEFF' + CSV_HEADERS.join(',') + '\r\n,iso:2999-01-01T00:00:00+08:00,原创,账号A,模板X,x,,[],[]\r\n') },
      { name: '多余文件.txt', buffer: Buffer.from('x') }
    ]);
    assert.match((await postImport(extra2)).body.error, /不允许的条目/);
    const badHeader = buildImportZip(CSV_HEADERS.slice(0, 4).join(',') + '\n1,2,3,4', {});
    assert.match((await postImport(badHeader)).body.error, /缺少必需列/);
  });

  it('魔数与扩展名不符 → 400', async () => {
    const csv = csvLines([rowCells({ __imgs: ['fake.png'] })]);
    const zip = buildImportZip(csv, { 'fake.png': Buffer.from('not a png at all!!!') });
    const res = await postImport(zip);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /魔数|内容与扩展名/);
  });

  it('并发锁 → 第二个请求 409', async () => {
    const csv = csvLines([rowCells({ __imgs: ['lock.png'] })]);
    const zip = buildImportZip(csv, { 'lock.png': MIN_PNG });
    store.data.jobs = [];
    // 拖慢 storage.put，确保第一个请求持锁期间第二个到达
    const st = globalThis.__storage;
    const origPut = st.put.bind(st);
    st.put = async (b, n, m) => {
      await new Promise(r => setTimeout(r, 120));
      return origPut(b, n, m);
    };
    try {
      const p1 = postImport(zip);
      await new Promise(r => setTimeout(r, 30)); // 第一个已持锁
      const p2 = postImport(zip);
      const [r1, r2] = await Promise.all([p1, p2]);
      const statuses = [r1.status, r2.status].sort();
      assert.ok(statuses.includes(200), `statuses=${statuses}`);
      assert.ok(statuses.includes(409), `statuses=${statuses}`);
    } finally {
      st.put = origPut;
    }
  });

  it('空行/注释行进 skipped', async () => {
    store.data.jobs = [];
    const csv = CSV_HEADERS.join(',') + '\r\n' +
      '# 注释行\r\n' +
      '导入标题,iso:' + new Date(Date.now() + 86400000).toISOString().replace('Z', '+00:00') + ',原创,账号A,模板X,正文,,[],[]\r\n' +
      '\r\n';
    const res = await postImport(buildImportZip(csv, {}));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.skipped.length, 2); // 注释 + 空行
    assert.strictEqual(res.body.created.length, 1);
  });
});
