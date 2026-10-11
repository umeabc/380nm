const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const express = require('express');
const createRoutes = require('../src/routes');
const { LocalStorage } = require('../src/storage/local');

test('R2受控降级URL、无公网502、源删除404和过载503', async () => {
  for (const scenario of ['fallback', 'unsafe', 'missing', 'overload', 'disabled']) {
    const key = 'dyn/example.png';
    const publicBase = 'https://images.example.test/base';
    const image = { key, userId: 'u', url: scenario === 'unsafe' ? 'https://evil.example.test/x' : publicBase + '/' + key };
    const store = { getSession: () => ({ user: { id: 'u', role: 'user' } }), listImages: () => [image], listJobs: () => [] };
    const storage = { name: 'r2', cfg: { publicBase, bucket: 'test' }, statForThumbnail: async () => {
      if (scenario === 'missing') throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      if (scenario === 'overload') throw Object.assign(new Error('full'), { code: 'OVERLOAD' });
      return { size: 2, version: scenario };
    }, readForThumbnail: async () => { throw new Error('network failure'); } };
    const previous = process.env.THUMB_ENABLED;
    if (scenario === 'disabled') process.env.THUMB_ENABLED = '0';
    const app = express(); app.use('/api', createRoutes({ store, storage }));
    if (previous === undefined) delete process.env.THUMB_ENABLED; else process.env.THUMB_ENABLED = previous;
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/thumb/${key}`, { headers: { cookie: 'sid=u' }, redirect: 'manual' });
      assert.equal(response.status, { fallback: 302, unsafe: 502, missing: 404, overload: 503, disabled: 302 }[scenario]);
      if (response.status === 302) { assert.equal(response.headers.get('location'), image.url); assert.equal(response.headers.get('cache-control'), 'no-store'); }
      if (response.status === 503) assert.equal(response.headers.get('retry-after'), '5');
    } finally { await new Promise(r => server.close(r)); }
  }
});

test('HTTP授权、WebP、304、历史快照、源删除与非法参数', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-route-'));
  const old = process.env.DATA_DIR;
  const storage = new LocalStorage(path.join(dir, 'uploads')); await storage.init();
  const buffer = await sharp({ create: { width: 700, height: 400, channels: 3, background: 'red' } }).png().toBuffer();
  const image = { ...(await storage.put(buffer, '图.png')), userId: 'u' };
  const users = { u: { id: 'u', role: 'user' }, other: { id: 'other', role: 'user' }, admin: { id: 'admin', role: 'admin' } };
  let images = [image];
  const store = { getSession: token => users[token] && { user: users[token] }, listImages: () => images, listJobs: () => [{ userId: 'u', images: [image] }], save() { throw new Error('禁止写DB'); }, addLog() { throw new Error('禁止日志'); } };
  // 配置模块不改生产配置，隔离派生根。
  const { config } = require('../src/config'); const previous = config.dataDir; config.dataDir = dir;
  const app = express(); app.use('/api', createRoutes({ store, storage }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/thumb/${image.key}`;
  const request = (suffix = '', user = 'u', headers = {}) => fetch(base + suffix, { headers: { ...(user && { cookie: `sid=${user}` }), ...headers }, redirect: 'manual' });
  try {
    assert.equal((await request('', null)).status, 401);
    assert.equal((await request('', 'other')).status, 404);
    const first = await request('?w=240'); assert.equal(first.status, 200); assert.equal(first.headers.get('content-type'), 'image/webp');
    assert.match(first.headers.get('cache-control'), /private/); assert.equal(first.headers.get('vary'), 'Cookie');
    const etag = first.headers.get('etag'); assert.equal((await sharp(Buffer.from(await first.arrayBuffer())).metadata()).width, 240);
    assert.equal((await request('', 'u', { 'if-none-match': etag })).status, 304);
    assert.equal((await request('', 'admin')).status, 200);
    assert.equal((await request('', 'other', { 'if-none-match': etag })).status, 404);
    for (const key of ['%2e%2e%2Fx.png', '%252e%252e/x.png', '%2Fabsolute.png', 'a%00.png', 'a%5Cb.png']) {
      const response = await fetch(base.replace(image.key, key), { headers: { cookie: 'sid=u' } });
      assert.equal(response.status, 400);
    }
    for (const query of ['?w=241', '?w=240&w=480', '?url=https://evil.test', '?w=240.0']) assert.equal((await request(query)).status, 400);
    images = []; assert.equal((await request()).status, 200);
    await storage.delete(image.key); assert.equal((await request('', 'u', { 'if-none-match': etag })).status, 404);
  } finally {
    config.dataDir = previous; if (old === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = old;
    await new Promise(r => server.close(r)); await fs.rm(dir, { recursive: true, force: true });
  }
});
