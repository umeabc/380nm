const path = require('path');
const { config } = require('./config');

// 缩略图是可丢弃的派生数据，尺寸和算法不可由请求任意扩展。
function thumbnailConfig(base = config, env = process.env) {
  const integer = (name, fallback, min, max) => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`非法配置 ${name}`);
    return value;
  };
  return {
    root: path.resolve(base.dataDir, 'thumbs'), algorithm: 'v1', quality: 80,
    enabled: integer('THUMB_ENABLED', 1, 0, 1) === 1,
    concurrency: integer('THUMB_CONCURRENCY', 2, 1, 2),
    maxBytes: integer('THUMB_CACHE_MAX_MB', 512, 1, 4096) * 1024 ** 2,
    days: integer('THUMB_CACHE_DAYS', 30, 1, 365),
    fetchTimeout: integer('THUMB_FETCH_TIMEOUT_MS', 10000, 100, 10000),
    inputBytes: 50 * 1024 ** 2, pixels: 40000000,
    queue: 64, waitTimeout: 10000, responseTimeout: 30000, waiters: 32
  };
}
function validateKey(key) {
  if (typeof key !== 'string' || !key || key.length > 1024 || /[\\\x00-\x1f%:?#]/.test(key) || key.startsWith('/') || key.split('/').some(p => !p || p === '.' || p === '..')) {
    throw Object.assign(new Error('非法图片 key'), { code: 'BAD_KEY' });
  }
  return key;
}
module.exports = { thumbnailConfig, validateKey };
