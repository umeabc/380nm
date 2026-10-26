/**
 * 受控原图下载：/uploads/<key>
 *
 * 与 /api/thumb 同源同鉴权：必须登录，且 key 必须有「当前用户（或管理员）」的归属，
 * 归属判据与缩略图一致（图库记录 / 可见任务的 images 快照）。未登录 401，
 * 无权、不存在、路径非法一律 404，不泄露「存在但无权」。
 *
 * 只用于本地存储；R2 驱动有自己的公开/受控地址，不经过这里。
 */
const { attachUser } = require('./auth');
const { validateKey } = require('./thumb-config');
const { findReadableImage } = require('./image-access');

// 原图同样是私人内容：只允许浏览器私有缓存，且必须按 Cookie 区分，
// 不能再沿用旧的公开 max-age=7d。
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, max-age=0, must-revalidate',
  Vary: 'Cookie'
};

/** 从挂载点下的 req.url 取出 key；非法编码/非法 key 统一按不存在处理。 */
function keyFromUrl(url) {
  const raw = String(url || '').split('?')[0];
  if (!raw.startsWith('/')) return null;
  try {
    return validateKey(decodeURIComponent(raw.slice(1)));
  } catch (e) {
    return null;
  }
}

function createUploadsMiddleware({ store, storage }) {
  const attach = attachUser(store);
  return (req, res, next) => {
    if (storage.name !== 'local') return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    attach(req, res, () => {
      if (!req.user) return res.status(401).json({ error: '未登录或会话已过期' });
      const key = keyFromUrl(req.url);
      if (!key || !findReadableImage(store, key, req.user)) {
        return res.status(404).json({ error: '图片不存在' });
      }
      // validateKey 之后仍要 realpath 包含性检查：拒绝符号链接逃逸。
      storage.fileForRead(key).then(({ file, contentType }) => {
        res.set(Object.assign({ 'Content-Type': contentType }, HEADERS));
        // sendFile 自带 HEAD、Range、ETag/Last-Modified/304；cacheControl 必须为 true
        // 才会走条件请求，但它不会覆盖我们已设置的 Cache-Control（见 send.setHeader）。
        // dotfiles 放行是因为路径已过 validateKey 且 realpath 必须仍在上传根内。
        res.sendFile(file, { cacheControl: true, maxAge: 0, acceptRanges: true, dotfiles: 'allow' }, (err) => {
          if (!err || res.headersSent || res.destroyed) return;
          res.status(404).json({ error: '图片不存在' });
        });
      }).catch((e) => {
        if (res.headersSent || res.destroyed) return;
        // 不存在/越界与「存在但无权」同样回 404，不泄露差异。
        if (e.code !== 'BAD_KEY' && e.code !== 'ENOENT') console.error('[uploads]', e);
        res.status(404).json({ error: '图片不存在' });
      });
    });
  };
}

module.exports = { createUploadsMiddleware, keyFromUrl };
