const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { thumbnailConfig, validateKey } = require('../src/thumb-config');
const { createThumbnailService, Gate } = require('../src/thumbs');
const { LocalStorage } = require('../src/storage/local');

test('真实转码、缓存、覆盖与删除不修改原图', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-thumb-'));
  const storage = new LocalStorage(path.join(dir, 'uploads')); await storage.init();
  const original = await sharp({ create: { width: 600, height: 300, channels: 4, background: '#ff000080' } }).png().toBuffer();
  const record = await storage.put(original, 'test.png');
  const service = createThumbnailService({ storage, config: thumbnailConfig({ dataDir: dir }, {}) });
  try {
    const settled = await Promise.allSettled(Array.from({ length: 100 }, () => service.get({ key: record.key })));
    const results = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
    assert.ok(results.length > 0);
    assert.ok(settled.filter(r => r.status === 'rejected').every(r => r.reason.code === 'OVERLOAD'));
    assert.equal(service.stats.generated, 1);
    const meta = await sharp(await fs.readFile(results[0].file)).metadata();
    assert.equal(meta.format, 'webp'); assert.equal(meta.width, 240); assert.equal(meta.height, 120); assert.equal(meta.hasAlpha, true);
    assert.deepEqual((await storage.get(record.key)).buffer, original);
    await service.get({ key: record.key }); assert.equal(service.stats.generated, 1);
    await fs.writeFile(storage._path(record.key), await sharp({ create: { width: 40, height: 80, channels: 3, background: 'blue' } }).png().toBuffer());
    const changed = await service.get({ key: record.key }); assert.notEqual(changed.etag, results[0].etag);
    assert.equal((await sharp(await fs.readFile(changed.file)).metadata()).height, 80);
    assert.equal((await service.sweep()).removed, 2);
    await assert.rejects(fs.stat(results[0].file), { code: 'ENOENT' });
    assert.ok((await fs.stat(changed.file)).size > 0);
    await storage.delete(record.key); await assert.rejects(service.get({ key: record.key }), { code: 'ENOENT' });
  } finally { service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
test('EXIF转正去metadata与动画GIF首帧', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-quality-'));
  const storage = new LocalStorage(path.join(dir, 'uploads')); await storage.init();
  const service = createThumbnailService({ storage, config: thumbnailConfig({ dataDir: dir }, {}) });
  try {
    const jpeg = await sharp({ create: { width: 600, height: 300, channels: 3, background: 'red' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const photo = await storage.put(jpeg, 'exif.jpg');
    const result = await service.get({ key: photo.key });
    const meta = await sharp(await fs.readFile(result.file)).metadata();
    assert.equal(meta.width, 120); assert.equal(meta.height, 240); assert.equal(meta.exif, undefined); assert.equal(meta.orientation, undefined);
    const raw = Buffer.concat([Buffer.alloc(2 * 2 * 3, 255), Buffer.alloc(2 * 2 * 3, 0)]);
    const gif = await sharp(raw, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } }).gif({ delay: [100, 100], loop: 0 }).toBuffer();
    const animation = await storage.put(gif, 'animation.gif');
    const thumb = await service.get({ key: animation.key });
    const preview = await sharp(await fs.readFile(thumb.file)).metadata();
    assert.equal(preview.height, 2); assert.ok(!preview.pages || preview.pages === 1);
    assert.deepEqual((await storage.get(animation.key)).buffer, gif);
  } finally { service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('真实发布stub收到原图SHA-256', async () => {
  const { Scheduler } = require('../src/scheduler');
  const crypto = require('crypto');
  const original = await sharp({ create: { width: 400, height: 200, channels: 3, background: 'green' } }).png().toBuffer();
  const digest = b => crypto.createHash('sha256').update(b).digest('hex');
  let received;
  const job = { id: 'j', status: 'pending', accountId: 'a', userId: 'u', text: 'test', images: [{ key: 'x', name: 'x.png', url: '/uploads/x' }] };
  const store = { getJob: () => job, getAccount: () => ({ uid: '1' }), listLibAccounts: () => [], updateJob: async (_, patch) => Object.assign(job, patch), addLog: async () => {} };
  await new Scheduler({ store, storage: { get: async () => ({ buffer: original, contentType: 'image/png' }) }, bili: { uploadImage: async ({ buffer }) => { received = digest(buffer); return {}; }, createDynamic: async () => ({ dynamicId: '1', url: 'test' }) }, config: { maxAttempts: 1 } }).processJob('j');
  assert.equal(job.status, 'published'); assert.equal(received, digest(original));
});

test('60张生成图库冷暖压测与字节指标', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-load-'));
  const storage = new LocalStorage(path.join(dir, 'uploads')); await storage.init();
  const service = createThumbnailService({ storage, config: thumbnailConfig({ dataDir: dir }, {}) });
  const images = [];
  try {
    for (let n = 0; n < 60; n++) {
      const width = 800 + n * 2, height = n % 2 ? 1200 : 600;
      const raw = Buffer.alloc(width * height * 3);
      // 可重复的纹理测试图，不借生产图库或凭据。
      for (let i = 0; i < raw.length; i++) raw[i] = ((i * 73 + n * 19) ^ (i >> 5)) & 255;
      const buffer = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
      images.push({ ...(await storage.put(buffer, 'fixture.png')), bytes: buffer.length });
    }
    const report = {};
    for (const width of [240, 480]) {
      const start = Date.now();
      const results = await Promise.all(images.map(i => service.get({ key: i.key, width })));
      const sizes = results.map(r => r.size).sort((a, b) => a - b);
      const coldMs = Date.now() - start, warm = Date.now();
      await Promise.all(images.map(i => service.get({ key: i.key, width })));
      report[width] = { coldMs, warmMs: Date.now() - warm, p95Bytes: sizes[Math.ceil(sizes.length * .95) - 1], maxBytes: sizes.at(-1), reduction: 1 - sizes.reduce((a, b) => a + b, 0) / images.reduce((a, b) => a + b.bytes, 0) };
      assert.ok(report[width].p95Bytes <= (width === 240 ? 30 : 80) * 1024);
      assert.ok(report[width].maxBytes <= (width === 240 ? 60 : 150) * 1024);
    }
    t.diagnostic(JSON.stringify(report));
    assert.equal(service.stats.generated, 120);
  } finally { service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('分批清理旧算法、容量和过期仅派生目录', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-sweep-'));
  const storage = new LocalStorage(path.join(dir, 'uploads')); await storage.init();
  const cfg = thumbnailConfig({ dataDir: dir }, {});
  const service = createThumbnailService({ storage, config: cfg });
  try {
    await fs.mkdir(path.join(cfg.root, 'v0'), { recursive: true });
    await fs.writeFile(path.join(cfg.root, 'v0', 'old.webp'), 'old');
    const source = await storage.put(Buffer.from('original'), 'x.bin');
    const result = await service.sweep({ limit: 1 });
    assert.equal(result.removed, 1); assert.deepEqual((await storage.get(source.key)).buffer, Buffer.from('original'));
    assert.equal((await service.sweep()).removed, 0);
  } finally { service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('key与配置严格校验', () => {
  for (const key of ['../x', '/x', 'a//b', 'a\\b', 'a/%2e', 'C:x', 'a/./x']) assert.throws(() => validateKey(key));
  assert.equal(validateKey('dyn/中文 空格.png'), 'dyn/中文 空格.png');
  assert.throws(() => thumbnailConfig({ dataDir: '.' }, { THUMB_CONCURRENCY: '3' }));
});
test('假R2真实流限额与Abort、HEAD条件GET暖缓存', async () => {
  const { R2Storage } = require('../src/storage/r2');
  const { Readable } = require('stream');
  const buffer = await sharp({ create: { width: 600, height: 300, channels: 3, background: 'yellow' } }).png().toBuffer();
  let gets = 0, heads = 0, deleted = false;
  const client = { send: async (cmd, options) => {
    assert.ok(options.abortSignal);
    if (cmd.constructor.name === 'HeadObjectCommand') { heads++; if (deleted) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }); return { ETag: 'v1', ContentLength: buffer.length, LastModified: new Date(1) }; }
    gets++; assert.equal(cmd.input.IfMatch, 'v1');
    return { Body: Readable.from([buffer]), ContentLength: buffer.length };
  } };
  const storage = new R2Storage({ bucket: 'test', accountId: 'test' }, client);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-r2-'));
  const service = createThumbnailService({ storage, config: thumbnailConfig({ dataDir: dir }, {}) });
  try {
    await service.get({ key: 'dyn/x.png' });
    await service.get({ key: 'dyn/x.png' });
    assert.equal(gets, 1); assert.ok(heads >= 3);
    deleted = true;
    await assert.rejects(service.get({ key: 'dyn/x.png' }), { name: 'NotFound' });
    await assert.rejects(storage.readForThumbnail('dyn/x.png', { signal: new AbortController().signal, ifMatch: 'v1', maxBytes: 1 }), { code: 'TOO_LARGE' });
  } finally { service.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('有界队列不加载全部源且真实撤销等待', async () => {
  const gate = new Gate(2, 64, 100);
  let release;
  const hold = new Promise(r => { release = r; });
  const tasks = Array.from({ length: 279 }, () => gate.run(() => hold).catch(e => e.code));
  assert.equal(gate.active, 2); assert.equal(gate.queue.length, 64);
  release(); const results = await Promise.all(tasks);
  assert.equal(results.filter(v => v === 'OVERLOAD').length, 213);
  assert.equal(gate.active, 0);
  const controller = new AbortController();
  let releaseFirst, releaseSecond;
  const one = gate.run(() => new Promise(r => { releaseFirst = r; }));
  const two = gate.run(() => new Promise(r => { releaseSecond = r; }));
  const queued = gate.run(() => hold, controller.signal); controller.abort();
  await assert.rejects(queued, { code: 'ABORT_ERR' }); assert.equal(gate.queue.length, 0);
  releaseFirst(); releaseSecond(); await Promise.all([one, two]); assert.equal(gate.active, 0);
});
