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
    const ext = path.extname(p).toLowerCase();
    const contentType =
      Object.entries(EXT_BY_TYPE).find(([, e]) => e === ext)?.[0] || 'application/octet-stream';
    return { buffer, contentType };
  }

  async delete(key) {
    try {
      await fsp.unlink(this._path(key));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
}

module.exports = { LocalStorage };
