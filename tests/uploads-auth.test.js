/* 测试：受控原图 /uploads —— 登录、按用户隔离、Range/HEAD、路径安全、thumb 降级仍可用 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const sharp = require('sharp');
const { LocalStorage } = require('../src/storage/local');
const { createUploadsMiddleware } = require('../src/uploads');
const createRoutes = require('../src/routes');
const { config } = require('../src/config');

async function harness(t, { thumbEnabled } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '380nm-uploads-'));
  const storage = new LocalStorage(path.join(dir, 'uploads'));
  await storage.init();
  const png = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } }).png().toBuffer();
  const put = async (name) => ({ ...(await storage.put(png, name)), buffer: png });
  const own = { ...(await put('mine.png')), userId: 'u' };
  const others = { ...(await put('other.png')), userId: 'other' };
  const snapshotOnly = await put('snap.png'); // 不在图库，只在任务快照里
  const users = { u: { id: 'u', role: 'user' }, other: { id: 'other', role: 'user' }, admin: { id: 'admin', role: 'admin' } };
  const images = [own, others];
  const jobs = [{ userId: 'u', images: [snapshotOnly] }];
  const store = {
    getSession: (token) => users[token] && { user: users[token] },
    listImages: () => images,
    listJobs: () => jobs
  };

  // 缩略图配置在 createRoutes 构造时读取，必须在此之前设置并事后还原。
  const oldThumb = process.env.THUMB_ENABLED;
  const oldDataDir = config.dataDir;
  if (thumbEnabled !== undefined) process.env.THUMB_ENABLED = thumbEnabled ? '1' : '0';
  config.dataDir = dir;
  let routes;
  try {
    routes = createRoutes({ store, storage, loginThrottle: { check: () => ({ allowed: true }) } });
  } finally {
    if (oldThumb === undefined) delete process.env.THUMB_ENABLED; else process.env.THUMB_ENABLED = oldThumb;
    config.dataDir = oldDataDir;
  }

  const app = express();
  app.use('/uploads', createUploadsMiddleware({ store, storage }));
  app.use('/api', routes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise((r) => server.close(r)); await fsp.rm(dir, { recursive: true, force: true }); });

  const url = (key) => '/uploads/' + key.split('/').map(encodeURIComponent).join('/');
  const get = (key, { user = 'u', method = 'GET', headers = {} } = {}) =>
    fetch(base + url(key), { method, headers: { ...(user ? { cookie: `sid=${user}` } : {}), ...headers }, redirect: 'manual' });
  /** 用原始请求行发请求，避免 fetch/undici 自动加 cache-control: no-cache 或规范化 ../。 */
  const rawGet = (rawPath, headers = { cookie: 'sid=u' }, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: rawPath, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
  return { dir, storage, store, images, own, others, snapshotOnly, get, rawGet, url, base, png };
}

test('/uploads：未登录 401、他人 404、本人/管理员/任务快照 200 且私缓存', async (t) => {
  const h = await harness(t);
  assert.equal((await h.get(h.own.key, { user: null })).status, 401, '未登录必须 401');
  assert.equal((await h.get(h.others.key)).status, 404, '他人的 key 必须 404');
  assert.equal((await h.get(h.others.key, { user: 'admin' })).status, 200, '管理员可读全部');
  assert.equal((await h.get(h.snapshotOnly.key)).status, 200, '任务快照内的 key 同样可读');
  assert.equal((await h.get('202601/nope.png')).status, 404, '不存在的 key 404');
  assert.equal((await h.get('deadbeef')).status, 404, '无归属记录的真实文件也不得读取');

  const ok = await h.get(h.own.key);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ok.headers.get('cache-control'), /^private,/);
  assert.ok(!/public/i.test(ok.headers.get('cache-control')), '不得再公开缓存');
  assert.equal(ok.headers.get('vary'), 'Cookie');
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), h.png);
});

test('/uploads：HEAD、Range、ETag/304 与子目录 key', async (t) => {
  const h = await harness(t);
  assert.match(h.own.key, /^\d{6}\//, 'put 默认写入月份子目录，覆盖子目录 key');

  const head = await h.get(h.own.key, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-type'), 'image/png');
  assert.equal(Number(head.headers.get('content-length')), h.png.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);

  const range = await h.get(h.own.key, { headers: { range: 'bytes=0-9' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), `bytes 0-9/${h.png.length}`);
  assert.equal((await range.arrayBuffer()).byteLength, 10);

  const first = await h.get(h.own.key);
  const etag = first.headers.get('etag');
  assert.ok(etag, '应有 ETag');
  await first.arrayBuffer();
  // fetch 会在带 if-none-match 时自动加 Cache-Control: no-cache（fresh 因此判为过期），
  // 所以这里用原始 HTTP 请求验证真正浏览器的 304 路径。
  const notModified = await h.rawGet(h.url(h.own.key), { cookie: 'sid=u', 'if-none-match': etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers['vary'], 'Cookie');
});

test('/uploads：路径穿越、编码绕过、目录与符号链接逃逸一律 404', async (t) => {
  const h = await harness(t);
  for (const p of [
    '/uploads/../db.json',
    '/uploads/%2e%2e/db.json',
    '/uploads/%2e%2e%2fdb.json',
    '/uploads/..%2f..%2fetc%2fpasswd',
    '/uploads/a%00.png',
    '/uploads/a%5Cb.png',
    '/uploads/%2Fetc%2Fpasswd',
    '/uploads/./x.png',
    '/uploads//x.png',
    '/uploads/%E0%A4%A' // 非法百分号编码
  ]) {
    assert.equal((await h.rawGet(p)).status, 404, `应拒绝路径: ${p}`);
  }

  // 目录不能当文件返回
  const dirKey = path.dirname(h.own.key);
  h.images.push({ key: dirKey, userId: 'u' });
  assert.equal((await h.get(dirKey)).status, 404, '目录必须拒绝');

  // 符号链接：即使 key 合法且已登记为本人图片，也不得逃逸出上传根目录
  const outside = path.join(h.dir, 'outside.png');
  await fsp.writeFile(outside, h.png);
  const linkKey = '202610/link.png';
  await fsp.mkdir(path.join(h.storage.dir, '202610'), { recursive: true });
  let linked = true;
  try {
    await fsp.symlink(outside, path.join(h.storage.dir, linkKey));
  } catch (e) {
    linked = false; // Windows 无符号链接权限时跳过该断言
  }
  if (linked) {
    h.images.push({ key: linkKey, userId: 'u' });
    assert.equal((await h.get(linkKey)).status, 404, '指向根目录外的符号链接必须被拒绝');
  }
});

test('/uploads：thumb 降级 302 到受控原图且带 Cookie 可打开', async (t) => {
  const h = await harness(t, { thumbEnabled: false });
  const thumb = await fetch(`${h.base}/api/thumb/${h.own.key}`, { headers: { cookie: 'sid=u' }, redirect: 'manual' });
  assert.equal(thumb.status, 302);
  const target = thumb.headers.get('location');
  assert.equal(target, h.url(h.own.key), '降级目标仍指向 /uploads/<key>');

  const original = await fetch(h.base + target, { headers: { cookie: 'sid=u' } });
  assert.equal(original.status, 200, '同源 <img> 带 Cookie 能取到原图');
  assert.equal(original.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(h.base + target)).status, 401, '无 Cookie 时降级目标不可读');
});
