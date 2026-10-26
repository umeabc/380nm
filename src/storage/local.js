const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif'
};

/** 扩展名 → Content-Type；未知扩展名按二进制处理（配合 nosniff 不会嗅探成页面）。 */
const TYPE_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif'
};
function contentTypeForPath(file) {
  return TYPE_BY_EXT[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

class LocalStorage {
  constructor(dir) {
    this.dir = dir;
    this.name = 'local';
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  _path(key) {
    const base = path.resolve(this.dir);
    const p = path.resolve(base, key);
    if (p !== base && !p.startsWith(base + path.sep)) {
      throw new Error('非法的存储路径: ' + key);
    }
    return p;
  }

  async put(buffer, originalName = '', contentType = '') {
    let ext = path.extname(originalName || '').toLowerCase();
    if (!ext && EXT_BY_TYPE[contentType]) ext = EXT_BY_TYPE[contentType];
    if (!ext) ext = '.bin';
    const now = new Date();
    const prefix = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const key = `${prefix}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    const target = this._path(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buffer);
    return { key, url: `/uploads/${key}` };
  }

  async get(key) {
    const p = this._path(key);
    const buffer = await fsp.readFile(p);
    return { buffer, contentType: contentTypeForPath(p) };
  }

  /**
   * 只读下载：把 key 解析为可安全 sendFile 的真实路径。
   * 先过 validateKey（拒绝 ..、绝对路径、反斜杠等），再做 realpath 包含性检查
   * （拒绝符号链接逃逸），与 statForThumbnail 的判据一致。支持子目录 key。
   * 失败时抛出带 code 的错误：BAD_KEY / ENOENT（含非普通文件）。
   */
  async fileForRead(key) {
    require('../thumb-config').validateKey(key);
    const root = await fsp.realpath(this.dir);
    let file;
    try {
      file = await fsp.realpath(this._path(key));
    } catch (e) {
      if (e.code === 'ENOENT') throw Object.assign(new Error('源不存在'), { code: 'ENOENT' });
      throw e;
    }
    if (!file.startsWith(root + path.sep)) {
      throw Object.assign(new Error('路径越界'), { code: 'BAD_KEY' });
    }
    const st = await fsp.stat(file);
    if (!st.isFile()) throw Object.assign(new Error('源不存在'), { code: 'ENOENT' });
    return { file, size: st.size, contentType: contentTypeForPath(file) };
  }

  async delete(key) {
    try {
      await fsp.unlink(this._path(key));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }

  /** 存储用量：图库目录占用字节 + 所在磁盘总量/剩余（statfs，平台不支持时返回 0） */
  async usage() {
    let totalBytes = 0;
    let freeBytes = 0;
    try {
      const st = await fsp.statfs(this.dir);
      totalBytes = st.blocks * st.bsize;
      freeBytes = st.bavail * st.bsize;
    } catch (e) { /* 平台/路径不支持时留空 */ }
    let usedBytes = 0;
    try { usedBytes = await this._dirSize(this.dir); } catch (e) { /* ignore */ }
    return { driver: 'local', usedBytes, totalBytes, freeBytes };
  }

  async _dirSize(dir) {
    let total = 0;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return total;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) total += await this._dirSize(p);
      else if (ent.isFile()) {
        try { total += (await fsp.stat(p)).size; } catch (e) { /* ignore */ }
      }
    }
    return total;
  }
  // 只读缩略接口：真实路径必须仍在上传根内，拒绝符号链接逃逸。
  async statForThumbnail(key) {
    require('../thumb-config').validateKey(key);
    const root = await fsp.realpath(this.dir);
    const file = await fsp.realpath(this._path(key));
    if (!file.startsWith(root + path.sep)) throw Object.assign(new Error('路径越界'), { code: 'BAD_KEY' });
    const st = await fsp.stat(file);
    if (!st.isFile()) throw Object.assign(new Error('源不存在'), { code: 'ENOENT' });
    return { size: st.size, version: `${st.size}:${st.mtimeMs}:${st.ctimeMs}` };
  }

  async readForThumbnail(key, { signal, maxBytes } = {}) {
    const meta = await this.statForThumbnail(key);
    if (meta.size > maxBytes) throw Object.assign(new Error('源图超限'), { code: 'TOO_LARGE' });
    const root = await fsp.realpath(this.dir);
    const file = await fsp.realpath(this._path(key));
    if (!file.startsWith(root + path.sep)) throw Object.assign(new Error('路径越界'), { code: 'BAD_KEY' });
    const handle = await fsp.open(file, 'r');
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) { await handle.close(); throw Object.assign(new Error('源图超限或非文件'), { code: 'TOO_LARGE' }); }
    try {
      const chunks = []; let size = 0;
      for await (const chunk of handle.createReadStream({ signal, autoClose: false })) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error('源图超限'), { code: 'TOO_LARGE' });
        chunks.push(chunk);
      }
      return { buffer: Buffer.concat(chunks), version: meta.version };
    } finally { await handle.close(); }
  }
}

module.exports = { LocalStorage };
