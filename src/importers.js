'use strict';
/* 图库链接导入：Pixiv 作品 / X(Twitter) 推文 / 直接图片链接
 *
 * 实现参考同机 moeflow 项目的 image_download.py：
 * - Pixiv:  GET https://www.pixiv.net/ajax/illust/{id}（公开作品无需登录，R18 需 PHPSESSID）
 *           多页作品再调 /ajax/illust/{id}/pages 拿全部原图；
 *           下载 i.pximg.net 必须带 Referer: https://www.pixiv.net/，否则 403
 * - X:      GET https://cdn.syndication.twimg.com/tweet-result?id={id}&lang=en&token=x（无需登录）
 *           取 mediaDetails[].media_url_https，加 ?name=orig 下载原图；
 *           失败回退推文页 og:image；受限推文可用全站 auth_token/ct0
 * - 代理：  站点设置里的 importProxy（HTTP 代理），通过 undici ProxyAgent 生效
 */

let undici = null;
try { undici = require('undici'); } catch (e) { /* 未安装 undici 时不支持代理 */ }
const http2 = require('http2');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PIXIV_ARTWORK_RE = /pixiv\.net\/(?:artworks|i)\/?(\d+)/;
const TWEET_URL_RE = /(?:status|statuses)\/(\d+)/;
const TWEET_HOST_RE = /^https?:\/\/(www\.)?(x|twitter)\.com\//i;

/* 部分站点的 Cloudflare 会拦截 HTTP/1.1 客户端（无论 TLS 指纹如何），
   需要 HTTP/2 + Chrome 风格 TLS 选项才能通过（实测 cdn.donmai.us 即如此，
   moeflow 用 curl_cffi impersonate="chrome" 解决同一问题，此处用 Node http2 等效实现） */
const H2_TLS_OPTS = {
  ciphers: [
    'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES256-SHA', 'ECDHE-RSA-AES128-SHA',
    'ECDHE-ECDSA-AES256-SHA', 'ECDHE-ECDSA-AES128-SHA',
    'AES256-GCM-SHA384', 'AES128-GCM-SHA256'
  ].join(':'),
  ecdhCurve: 'X25519:P-256:P-384',
  sigalgs: 'ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256:rsa_pkcs1_sha256:ecdsa_secp384r1_sha384:rsa_pss_rsae_sha384:rsa_pkcs1_sha384:rsa_pss_rsae_sha512:rsa_pkcs1_sha512',
  minVersion: 'TLSv1.2',
  ALPNProtocols: ['h2']
};

/** HTTP/2 GET（Chrome 风格 TLS），用于绕过封锁 HTTP/1.1 的 CDN */
function h2Get(url, { headers = {}, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new ImportError('无效链接')); }
    const session = http2.connect(u.origin, {
      ...H2_TLS_OPTS,
      // 大接收窗口：默认 64KB 流控窗口在高延迟链路上会限速（实测 donmai 4.6MB 从 20s+ 卡死提升到 6s 完成）
      settings: { initialWindowSize: 33554432 }
    });
    let settled = false;
    let status = 0;
    let contentType = '';
    let contentLength = 0;
    let received = 0;
    const chunks = [];
    const finish = (err, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session.close(); } catch (e) { /* ignore */ }
      if (err) reject(err);
      else resolve(data);
    };
    const timer = setTimeout(() => {
      session.destroy();
      finish(new ImportError('下载超时（HTTP/2）'));
    }, timeout);
    session.on('error', (e) => finish(e));
    const req = session.request({
      ':method': 'GET',
      ':path': u.pathname + u.search,
      'user-agent': UA,
      accept: '*/*',
      'accept-encoding': 'identity',
      ...headers
    });
    req.on('response', (h) => {
      status = h[':status'] || 0;
      contentType = h['content-type'] || '';
      contentLength = Number(h['content-length']) || 0;
      try { session.setLocalWindowSize(67108864); } catch (e) { /* 旧版 Node 无此 API 时忽略 */ }
    });
    req.on('data', (c) => {
      chunks.push(c);
      received += c.length;
      // Cloudflare 等对 HTTP/2 可能迟迟不发 END_STREAM，按 Content-Length 收满即完成
      if (contentLength && received >= contentLength) {
        finish(null, { status, contentType, buffer: Buffer.concat(chunks) });
      }
    });
    req.on('end', () => finish(null, { status, contentType, buffer: Buffer.concat(chunks) }));
    req.on('close', () => {
      if (settled) return;
      if (contentLength && received < contentLength) {
        finish(new ImportError(`下载中断（收到 ${received}/${contentLength} 字节）`));
      } else {
        finish(null, { status, contentType, buffer: Buffer.concat(chunks) });
      }
    });
    req.on('error', (e) => finish(e));
    req.end();
  });
}

class ImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImportError';
  }
}

function makeFetch(proxy) {
  if (proxy && undici && undici.ProxyAgent) {
    const agent = new undici.ProxyAgent(proxy);
    return (url, opts = {}) => undici.fetch(url, { ...opts, dispatcher: agent });
  }
  return (url, opts = {}) => fetch(url, opts);
}

/** 清洗文本用于文件名：去链接/非法字符/emoji，截 40 字 */
function cleanName(s) {
  let t = String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  t = t.replace(/https?:\/\/\S+/g, ' ').replace(/www\.\S+/g, ' ');
  t = t.replace(/[\\/:*?"<>|\r\n\t：；（）“”‘’「」『』#＃]+/g, ' ');
  t = t.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 40).replace(/[ ._]+$/g, '');
}

/** 推文时间字符串 → YYYYMMDDHHMM（用于文件名） */
function parseTweetTime(s) {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function extFromCt(ct) {
  const m = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/bmp': '.bmp', 'image/avif': '.avif'
  };
  return m[String(ct || '').split(';')[0].trim().toLowerCase()] || '.jpg';
}

async function downloadImage(url, { proxy, headers = {}, timeout = 60000 } = {}) {
  const f = makeFetch(proxy);
  let res;
  try {
    res = await f(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const cause = (e.cause && e.cause.message) || e.message;
    throw new ImportError('下载图片失败（网络错误：' + cause + '）：' + String(url).slice(0, 90));
  }
  // 拦截 HTTP/1.1 的 CDN（如 cdn.donmai.us 的 Cloudflare）：改用 HTTP/2 + Chrome 风格 TLS 直连重试
  if (res.status === 403 || res.status === 429) {
    let h2;
    try {
      h2 = await h2Get(url, { headers, timeout });
    } catch (e) {
      if (e instanceof ImportError) throw e;
      /* h2 也失败时沿用原 403 错误 */
    }
    if (h2 && h2.status >= 200 && h2.status < 300) {
      return { buffer: h2.buffer, contentType: h2.contentType };
    }
    if (h2 && h2.status >= 400 && h2.status !== 403 && h2.status !== 429) {
      throw new ImportError(`下载图片失败（HTTP ${h2.status}）：${String(url).slice(0, 90)}`);
    }
  }
  if (!res.ok) throw new ImportError(`下载图片失败（HTTP ${res.status}）：${String(url).slice(0, 90)}`);
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  if (!buffer.length) throw new ImportError('下载内容为空');
  const contentType = res.headers.get('content-type') || '';
  if (contentType && !contentType.split(';')[0].trim().toLowerCase().startsWith('image/')) {
    throw new ImportError('该链接不是图片');
  }
  return { buffer, contentType };
}

/* ---------------- Pixiv ---------------- */
async function importPixiv(url, { session = '', proxy = '', timeout = 60000 } = {}) {
  const m = PIXIV_ARTWORK_RE.exec(url);
  const id = m && m[1];
  if (!id) throw new ImportError('无法解析 Pixiv 作品地址，请确认是 https://www.pixiv.net/artworks/<id> 格式');
  const f = makeFetch(proxy);
  const headers = { 'user-agent': UA, referer: 'https://www.pixiv.net/', accept: 'application/json' };
  if (session.trim()) headers.cookie = 'PHPSESSID=' + session.trim();

  let res;
  try {
    res = await f(`https://www.pixiv.net/ajax/illust/${id}`, { headers, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    const cause = (e.cause && e.cause.message) || e.message;
    throw new ImportError('连接 Pixiv 失败（网络错误：' + cause + '。请在全站设置里配置下载代理）');
  }
  if (!res.ok) throw new ImportError(`获取 Pixiv 作品信息失败（HTTP ${res.status}）`);
  const data = await res.json();
  if (data.error || !data.body) throw new ImportError('获取 Pixiv 作品信息失败（可能已删除或需要登录，R18 作品需在全站设置里配置 PHPSESSID）');
  const body = data.body;
  const title = body.illustTitle || '';
  let urls = [];
  const first = (body.urls || {}).original;
  if (first) urls.push(first);
  const pageCount = Number(body.pageCount) || 1;
  if (pageCount > 1) {
    try {
      const pr = await f(`https://www.pixiv.net/ajax/illust/${id}/pages`, { headers, signal: AbortSignal.timeout(timeout) });
      if (pr.ok) {
        const pd = await pr.json();
        if (!pd.error && Array.isArray(pd.body)) {
          const pages = pd.body.map((p) => p.urls && p.urls.original).filter(Boolean);
          if (pages.length) urls = pages;
        }
      }
    } catch (e) { /* 拿不到分页就退回单页 */ }
  }
  if (!urls.length) throw new ImportError('该作品未找到原图');

  const out = [];
  for (let i = 0; i < urls.length; i++) {
    const dl = await downloadImage(urls[i], {
      proxy,
      headers: { referer: 'https://www.pixiv.net/' },
      timeout
    });
    out.push({
      buffer: dl.buffer,
      contentType: dl.contentType,
      name: `Pixiv-${id}-${cleanName(title) || 'untitled'}-P${i + 1}${extFromCt(dl.contentType)}`
    });
  }
  return out;
}

/* ---------------- X (Twitter) ---------------- */
async function importTwitter(url, { authToken = '', ct0 = '', proxy = '', timeout = 60000 } = {}) {
  const m = TWEET_URL_RE.exec(url);
  const id = m && m[1];
  if (!id) throw new ImportError('无法解析推文地址，请确认是 https://x.com/<用户>/status/<id> 格式');
  const f = makeFetch(proxy);
  const mediaUrls = [];
  let text = '';
  let createdAt = '';
  let syndicationOk = false;

  // 主路：syndication 公开接口（无需登录）。成功即权威：无图就是无图
  try {
    const r = await f(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=x`, {
      headers: { 'user-agent': UA, referer: 'https://x.com/', accept: 'application/json' },
      signal: AbortSignal.timeout(timeout)
    });
    if (r.ok) {
      syndicationOk = true;
      const data = await r.json();
      text = data.text || '';
      createdAt = data.created_at || '';
      for (const md of data.mediaDetails || []) if (md.media_url_https) mediaUrls.push(md.media_url_https);
      if (!mediaUrls.length) {
        for (const md of ((data.extended_entities || {}).media || [])) if (md.media_url_https) mediaUrls.push(md.media_url_https);
      }
    }
  } catch (e) { /* 走回退 */ }

  // 回退：推文页 og:image / 内嵌 JSON（仅在 syndication 不可用时）
  if (!mediaUrls.length && !syndicationOk) {
    const headers = { 'user-agent': UA, referer: 'https://x.com/' };
    if (authToken && ct0) headers.cookie = `auth_token=${authToken}; ct0=${ct0}`;
    let r2;
    try {
      r2 = await f(url.replace('//twitter.com', '//x.com'), { headers, signal: AbortSignal.timeout(timeout) });
    } catch (e) {
      throw new ImportError('连接 X 失败（网络错误，请在全站设置里配置下载代理）');
    }
    if (r2.ok) {
      const html = await r2.text();
      const og = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/.exec(html)
        || /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/.exec(html)
        || /"media_url_https"\s*:\s*"([^"]+)"/.exec(html);
      if (og) mediaUrls.push(og[1]);
    }
  }
  if (!mediaUrls.length) throw new ImportError('该推文中未找到图片（纯文字推文，或受限内容需在全站设置里配置 auth_token/ct0）');

  const out = [];
  for (let i = 0; i < mediaUrls.length; i++) {
    let u = mediaUrls[i];
    // 只对正文图片加 name=orig 取原图（头像等 URL 加了会 404）
    if (/pbs\.twimg\.com\/media\//.test(u) && !/[?&]name=/.test(u)) u += (u.includes('?') ? '&' : '?') + 'name=orig';
    const headers = { referer: 'https://x.com/' };
    if (authToken && ct0) headers.cookie = `auth_token=${authToken}; ct0=${ct0}`;
    const dl = await downloadImage(u, { proxy, headers, timeout });
    const ts = parseTweetTime(createdAt) || id;
    out.push({
      buffer: dl.buffer,
      contentType: dl.contentType,
      name: `X-${cleanName(text) || 'tweet'}-${ts}-P${i + 1}${extFromCt(dl.contentType)}`
    });
  }
  return out;
}

/* ---------------- 直接图片链接 ---------------- */
async function importExternal(url, { proxy = '', timeout = 60000 } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new ImportError('链接必须以 http/https 开头');
  const dl = await downloadImage(url, { proxy, timeout });
  const base = decodeURIComponent(String(url).split('?')[0].split('/').pop() || 'import');
  let stem = base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'import';
  if (!/\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(stem)) stem += extFromCt(dl.contentType);
  return [{ buffer: dl.buffer, contentType: dl.contentType, name: stem }];
}

/* ---------------- 统一入口 ---------------- */
async function importFromUrl(url, settings = {}) {
  const u = String(url || '').trim();
  if (!u) throw new ImportError('请输入链接');
  const opts = {
    session: settings.pixivSession || '',
    authToken: settings.twitterAuth || '',
    ct0: settings.twitterCt0 || '',
    proxy: settings.importProxy || ''
  };
  if (PIXIV_ARTWORK_RE.test(u)) return importPixiv(u, opts);
  if (TWEET_HOST_RE.test(u)) return importTwitter(u, opts);
  return importExternal(u, opts);
}

module.exports = { importFromUrl, ImportError };
