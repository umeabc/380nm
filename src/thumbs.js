const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

/** 魔数嗅探：只放行图库实际会出现的格式，避免把 heif/avif/svg/tiff 等容器交给
 *  libvips 解码器（sharp 0.34.x 的 libheif/librsvg 已知存在高危漏洞，且测试机 CPU
 *  不支持 0.35.x 预编译包，故在进入 sharp 之前直接拦截非白名单格式）。 */
function sniffImageFormat(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'gif';
  if (buf[0] === 0x42 && buf[1] === 0x4D) return 'bmp';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  return null;
}
const SNIFF_ALLOWED = new Set(['jpeg', 'png', 'gif', 'bmp', 'webp']);
const { validateKey } = require('./thumb-config');
sharp.concurrency(1);
sharp.cache({ memory: 16, files: 0, items: 20 });
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const error = code => Object.assign(new Error(code), { code });

// 有界槽位覆盖读取、转码和提交；等待超时真正从队列移除。
class Gate {
  constructor(max, limit, timeout) { this.max = max; this.limit = limit; this.timeout = timeout; this.active = 0; this.queue = []; }
  async run(fn, signal) {
    if (signal?.aborted) throw error('ABORT_ERR');
    if (this.active >= this.max) {
      if (this.queue.length >= this.limit) throw error('OVERLOAD');
      await new Promise((resolve, reject) => {
        const item = { resolve: () => { clean(); resolve(); } };
        const cancel = () => { const i = this.queue.indexOf(item); if (i >= 0) this.queue.splice(i, 1); clean(); reject(error(signal?.aborted ? 'ABORT_ERR' : 'OVERLOAD')); };
        const timer = setTimeout(cancel, this.timeout);
        const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
        signal?.addEventListener('abort', cancel, { once: true });
        this.queue.push(item);
      });
    } else this.active++;
    try { return await fn(); }
    finally { const next = this.queue.shift(); if (next) next.resolve(); else this.active--; }
  }
}
function createThumbnailService({ storage, config }) {
  const namespace = hash(JSON.stringify([storage.name, storage.dir && path.resolve(storage.dir), storage.cfg?.accountId, storage.cfg?.endpoint, storage.cfg?.bucket]));
  const gate = new Gate(config.concurrency, config.queue, config.waitTimeout);
  const heads = new Gate(4, 64, config.waitTimeout);
  const flights = new Map(), headFlights = new Map(), reads = new Map(), failures = new Map();
  const stats = { hits: 0, generated: 0, failed: 0, sourceBytes: 0, cleanedBytes: 0 };
  let closed = false, sweptAt = Date.now();
  async function single(map, id, factory, signal) {
    let task = map.get(id);
    if (!task) {
      const controller = new AbortController();
      task = { controller, consumers: 0 };
      task.promise = Promise.resolve().then(() => factory(controller.signal)).finally(() => map.delete(id));
      // 消费者全部离开时仍收集后台拒绝，避免未处理异常。
      task.promise.catch(() => {});
      map.set(id, task);
    }
    if (task.consumers >= config.waiters) throw error('OVERLOAD');
    task.consumers++;
    try {
      if (!signal) return await task.promise;
      if (signal.aborted) throw error('ABORT_ERR');
      return await new Promise((resolve, reject) => {
        const abort = () => reject(error('ABORT_ERR'));
        signal.addEventListener('abort', abort, { once: true });
        task.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    } finally { if (--task.consumers === 0) task.controller.abort(); }
  }
  async function metadata(key, signal) {
    validateKey(key);
    return single(headFlights, key, s => heads.run(() => storage.statForThumbnail(key, { signal: AbortSignal.any([s, AbortSignal.timeout(config.fetchTimeout)]) }), s), signal);
  }
  function location(key, width, meta) {
    const kh = hash(key);
    const dir = path.join(config.root, config.algorithm, namespace, kh.slice(0, 2), kh);
    const stem = `${hash(meta.version)}-w${width}-webp-q${config.quality}`;
    return { dir, file: path.join(dir, stem + '.webp'), side: path.join(dir, stem + '.json') };
  }
  async function cached(loc) {
    try {
      const side = JSON.parse(await fs.readFile(loc.side, 'utf8'));
      if ((await fs.stat(loc.file)).size !== side.size) return null;
      if (Date.now() - (await fs.stat(loc.side)).mtimeMs > 3600000) {
        // 访问时间只按小时落盘，失败不影响已提交图片。
        await fs.utimes(loc.side, new Date(), new Date());
      }
      stats.hits++;
      return { file: loc.file, etag: side.etag, size: side.size, contentType: 'image/webp' };
    } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; return null; }
  }
  async function generate(key, width, meta, signal, retry = 0) {
    if (meta.size > config.inputBytes) throw error('TOO_LARGE');
    const loc = location(key, width, meta);
    const found = await cached(loc); if (found) return found;
    const timed = AbortSignal.any([signal, AbortSignal.timeout(config.fetchTimeout)]);
    let input;
    try {
      input = await single(reads, key + ':' + meta.version, async s => {
        const result = await storage.readForThumbnail(key, { signal: AbortSignal.any([s, timed]), ifMatch: meta.etag, maxBytes: config.inputBytes });
        stats.sourceBytes += result.buffer.length; return result;
      }, timed);
    } catch (e) {
      if ((e.$metadata?.httpStatusCode === 412 || e.code === 'SOURCE_CHANGED') && retry < 1) return generate(key, width, await metadata(key, signal), signal, retry + 1);
      throw e;
    }
    const sniffed = sniffImageFormat(input.buffer);
    if (!sniffed || !SNIFF_ALLOWED.has(sniffed)) {
      // 非白名单容器（heif/avif/svg/tiff/未知）：不进入解码器，直接按不支持处理
      throw error('UNSUPPORTED');
    }
    const pipeline = sharp(input.buffer, { animated: false, limitInputPixels: config.pixels, failOn: 'error' });
    const abort = () => pipeline.destroy(error('ABORT_ERR'));
    timed.addEventListener('abort', abort, { once: true });
    let output;
    try {
      const info = await pipeline.metadata();
      if (['svg', 'pdf', 'tiff'].includes(info.format)) throw error('UNSUPPORTED');
      output = await pipeline.rotate().resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp({ quality: config.quality }).toBuffer();
    } finally { timed.removeEventListener('abort', abort); pipeline.destroy(); input = null; }
    const after = await metadata(key, signal);
    if (after.version !== meta.version) {
      if (retry >= 1) throw error('SOURCE_CHANGED');
      return generate(key, width, after, signal, retry + 1);
    }
    const etag = '"' + hash(output) + '"';
    await fs.mkdir(loc.dir, { recursive: true });
    const suffix = '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(loc.file + suffix, output, { flag: 'wx' });
      await fs.writeFile(loc.side + suffix, JSON.stringify({ etag, size: output.length, accessed: Date.now(), generated: Date.now(), sourceVersion: hash(meta.version) }), { flag: 'wx' });
      // sidecar 最后提交，读者只接收完整的一对派生文件。
      await fs.rename(loc.file + suffix, loc.file);
      await fs.rename(loc.side + suffix, loc.side);
    } finally {
      await Promise.all([loc.file + suffix, loc.side + suffix].map(p => fs.unlink(p).catch(() => {})));
    }
    stats.generated++;
    if (Date.now() - sweptAt > 3600000) { sweptAt = Date.now(); setImmediate(() => sweep().catch(() => {})); }
    return { file: loc.file, etag, size: output.length, contentType: 'image/webp' };
  }
  async function get({ key, width = 240, sourceMeta, signal }) {
    if (closed) throw error('OVERLOAD');
    validateKey(key); if (![240, 480].includes(width)) throw error('BAD_WIDTH');
    const budget = AbortSignal.timeout(config.responseTimeout);
    const combined = signal ? AbortSignal.any([signal, budget]) : budget;
    const meta = sourceMeta || await metadata(key, combined);
    if (meta.size > config.inputBytes) throw error('TOO_LARGE');
    const loc = location(key, width, meta);
    const found = await cached(loc); if (found) return found;
    const id = loc.file;
    const failure = failures.get(id);
    if (failure && failure.until > Date.now()) throw failure.error;
    if (failure) failures.delete(id);
    return single(flights, id, s => gate.run(async () => {
      try { return await generate(key, width, meta, s); }
      catch (e) {
        stats.failed++;
        if (!['OVERLOAD', 'ABORT_ERR', 'ENOENT', 'NoSuchKey', 'NotFound'].includes(e.code || e.name)) {
          if (failures.size >= 256) failures.delete(failures.keys().next().value);
          failures.set(id, { until: Date.now() + 30000, error: e });
        }
        throw e;
      }
    }, s), combined);
  }
  async function sweep({ limit = 100 } = {}) {
    // 独立分批回收；不触碰 uploads、数据库或 Danbooru。
    const files = [];
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else if (entry.isFile()) files.push({ file: p, ...(await fs.stat(p)) });
      }
    }
    const rootStat = await fs.lstat(config.root).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (rootStat?.isSymbolicLink()) throw error('BAD_KEY');
    await walk(config.root);
    // 图片的访问年龄采用最后提交标记，避免只更新sidecar却误删暖图。
    const byPath = new Map(files.map(f => [f.file, f]));
    for (const f of files) if (f.file.endsWith('.webp')) f.mtimeMs = byPath.get(f.file.replace(/\.webp$/, '.json'))?.mtimeMs || f.mtimeMs;
    // 同key目录内最新提交的源版本为当前版本，旧版本成对优先回收。
    const latest = new Map(), versions = new Map();
    for (const f of files.filter(f => f.file.endsWith('.json'))) {
      try {
        const meta = JSON.parse(await fs.readFile(f.file, 'utf8'));
        const version = meta.sourceVersion || path.basename(f.file).split('-w')[0];
        const generated = meta.generated || f.mtimeMs;
        versions.set(f.file, version);
        const dir = path.dirname(f.file);
        if (!latest.has(dir) || latest.get(dir).generated < generated) latest.set(dir, { version, generated });
      } catch (e) { /* 不完整提交由超龄/容量回收，不作为当前版本标记。 */ }
    }
    for (const f of files) {
      const side = f.file.replace(/\.webp$/, '.json');
      const version = versions.get(side);
      f.oldSource = !!version && latest.get(path.dirname(f.file))?.version !== version;
    }
    let total = files.reduce((n, f) => n + f.size, 0), removed = 0, bytes = 0;
    const now = Date.now();
    files.sort((a, b) => Number(b.oldSource) - Number(a.oldSource) || a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (removed >= limit) break;
      const oldAlgorithm = !f.file.startsWith(path.join(config.root, config.algorithm) + path.sep);
      if (oldAlgorithm || f.oldSource || (f.file.endsWith('.tmp') && now - f.mtimeMs > 300000) || now - f.mtimeMs > config.days * 86400000 || total > config.maxBytes) {
        if ([...flights.keys()].some(p => f.file.startsWith(p))) continue;
        await fs.unlink(f.file); total -= f.size; bytes += f.size; removed++;
      }
    }
    stats.cleanedBytes += bytes; return { removed, bytes, total };
  }
  return { get, metadata, sweep, stats, gates: { generation: gate, head: heads }, close() { closed = true; for (const map of [flights, headFlights, reads]) for (const t of map.values()) t.controller.abort(); } };
}
module.exports = { createThumbnailService, Gate, sniffImageFormat };
