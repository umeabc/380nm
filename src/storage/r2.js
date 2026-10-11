const crypto = require('crypto');
const path = require('path');

// 用量统计缓存（ListObjectsV2 遍历整桶，对频繁刷新做节流）
let usageCache = null;
let usageCachedAt = 0;
const USAGE_TTL_MS = 30000;

const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/avif': '.avif'
};

/**
 * Cloudflare R2 存储（S3 兼容）。
 * 使用前提：
 *   1. npm install @aws-sdk/client-s3
 *   2. 配置环境变量 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET
 *   3. （推荐）R2_PUBLIC_BASE 填自定义域名或 r2.dev 公网地址，用于前端预览
 */
class R2Storage {
  constructor(cfg, client) {
    this.cfg = cfg;
    this.client = client;
    this.name = 'r2';
  }

  static async create(cfg) {
    let sdk;
    try {
      sdk = require('@aws-sdk/client-s3');
    } catch (e) {
      throw new Error('使用 R2 存储需要先安装依赖: npm install @aws-sdk/client-s3');
    }
    const missing = ['accountId', 'accessKeyId', 'secretAccessKey', 'bucket'].filter((k) => !cfg[k]);
    if (missing.length) {
      throw new Error('R2 配置不完整，缺少: ' + missing.join(', ') + '（环境变量 R2_*，详见 README）');
    }
    const client = new sdk.S3Client({
      region: 'auto',
      endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey
      }
    });
    return new R2Storage(cfg, client);
  }

  async put(buffer, originalName = '', contentType = '') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    let ext = path.extname(originalName || '').toLowerCase();
    if (!ext && EXT_BY_TYPE[contentType]) ext = EXT_BY_TYPE[contentType];
    if (!ext) ext = '.bin';
    const key = `dyn/${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentType || 'application/octet-stream'
      })
    );
    const base = (this.cfg.publicBase || '').replace(/\/+$/, '');
    const url = base ? `${base}/${key}` : key;
    return { key, url };
  }

  async get(key) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key })
    );
    const buffer = Buffer.from(await res.Body.transformToByteArray());
    return { buffer, contentType: res.ContentType || 'image/jpeg' };
  }

  async delete(key) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }

  /** 存储用量：遍历桶内对象求和；配额默认 10GB（R2 免费额度，可被 R2_QUOTA_GB 覆盖） */
  async usage() {
    if (usageCache && Date.now() - usageCachedAt < USAGE_TTL_MS) return usageCache;
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    let usedBytes = 0;
    let objectCount = 0;
    let token;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.cfg.bucket, ContinuationToken: token })
      );
      for (const o of res.Contents || []) {
        usedBytes += o.Size || 0;
        objectCount++;
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    const quotaBytes = (this.cfg.quotaGb || 10) * 1024 ** 3;
    usageCache = {
      driver: 'r2',
      usedBytes,
      totalBytes: quotaBytes,
      freeBytes: Math.max(0, quotaBytes - usedBytes),
      objectCount
    };
    usageCachedAt = Date.now();
    return usageCache;
  }
  // 独立只读接口，不改变发布链路的 get；网络由真实 AbortSignal 限时。
  async statForThumbnail(key, { signal } = {}) {
    require('../thumb-config').validateKey(key);
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    const own = AbortSignal.timeout(10000);
    const res = await this.client.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
      { abortSignal: signal ? AbortSignal.any([signal, own]) : own });
    return { size: res.ContentLength, etag: res.ETag, contentType: res.ContentType,
      version: JSON.stringify([res.ETag, res.LastModified, res.ContentLength, res.VersionId]) };
  }

  async readForThumbnail(key, { signal, ifMatch, maxBytes } = {}) {
    require('../thumb-config').validateKey(key);
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, IfMatch: ifMatch }), { abortSignal: signal });
    const body = res.Body;
    const abort = () => body.destroy?.(Object.assign(new Error('读取中止'), { code: 'ABORT_ERR' }));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      if (res.ContentLength > maxBytes) throw Object.assign(new Error('源图超限'), { code: 'TOO_LARGE' });
      const chunks = []; let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > maxBytes) throw Object.assign(new Error('源图超限'), { code: 'TOO_LARGE' });
        chunks.push(Buffer.from(chunk));
      }
      return { buffer: Buffer.concat(chunks), contentType: res.ContentType };
    } finally { signal?.removeEventListener('abort', abort); body.destroy?.(); }
  }
}

module.exports = { R2Storage };
