const crypto = require('crypto');
const { fetch } = require('undici');
const { BILIBILI_UA } = require('./bilibili');
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;
const COOKIE_NAMES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'sid', 'DedeUserID__ckMd5'];
class PassportError extends Error {
  constructor(stage, kind, code, httpStatus) {
    const safeMessage = `${stage}: ${kind}${code === undefined ? '' : ` (code ${code})`}`;
    super(safeMessage); this.name = 'PassportError';
    Object.assign(this, { stage, kind, code, httpStatus, safeMessage });
  }
}
function parseSetCookies(lines, initial = {}) {
  const cookies = { ...initial };
  for (const line of lines || []) {
    if (typeof line !== 'string' || /[\r\n]/.test(line)) throw new PassportError('cookie', 'protocol');
    const parts = line.split(';'); const first = parts.shift(); const eq = first.indexOf('=');
    const name = first.slice(0, eq).trim(), value = first.slice(eq + 1).trim();
    if (eq < 1 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) throw new PassportError('cookie', 'protocol');
    if (!COOKIE_NAMES.includes(name)) continue;
    const attrs = new Map(parts.map(p => { const i = p.indexOf('='); return i < 0 ? [p.trim().toLowerCase(), ''] : [p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()]; }));
    const domain = attrs.get('domain');
    if (domain && !['bilibili.com', '.bilibili.com', 'passport.bilibili.com', '.passport.bilibili.com'].includes(domain.toLowerCase())) continue;
    if (!value || (attrs.has('max-age') && Number(attrs.get('max-age')) <= 0) || (attrs.has('expires') && Date.parse(attrs.get('expires')) <= Date.now())) delete cookies[name];
    else cookies[name] = value;
  }
  return cookies;
}
function buildCorrespondPath(timestamp, encrypt = crypto.publicEncrypt) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new PassportError('info', 'protocol');
  return encrypt({ key: PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(`refresh_${timestamp}`, 'utf8')).toString('hex');
}
function extractRefreshCsrf(html) {
  const matches = [...html.matchAll(/<div\b([^>]*)>([^<]*)<\/div\s*>/gi)].filter(m => /\bid\s*=\s*(['"])1-name\1/i.test(m[1]));
  if (matches.length !== 1 || !matches[0][2].trim()) throw new PassportError('correspond', 'protocol');
  return matches[0][2].trim();
}
function credentialsCookies(c) {
  return { SESSDATA: c.sessdata, bili_jct: c.bili_jct, DedeUserID: c.mid || c.dedeUserID || c.uid, ...(c.sid ? { sid: c.sid } : {}), ...(c.dedeUserIDCheckMd5 ? { DedeUserID__ckMd5: c.dedeUserIDCheckMd5 } : {}) };
}
function cookieHeader(cookies) {
  return COOKIE_NAMES.filter(n => cookies[n] !== undefined).map(n => {
    const v = String(cookies[n]); if (/[\r\n;\s]/.test(v)) throw new PassportError('cookie', 'protocol');
    return `${n}=${v}`;
  }).join('; ');
}
function newCredentials(cookies, refreshToken) {
  if (!['SESSDATA', 'bili_jct', 'DedeUserID'].every(n => typeof cookies[n] === 'string' && cookies[n]) || !/^\d+$/.test(cookies.DedeUserID) || typeof refreshToken !== 'string' || !refreshToken || /[\r\n]/.test(refreshToken)) throw new PassportError('credentials', 'protocol');
  return { sessdata: cookies.SESSDATA, bili_jct: cookies.bili_jct, mid: cookies.DedeUserID, refreshToken, sid: cookies.sid, dedeUserIDCheckMd5: cookies.DedeUserID__ckMd5 };
}
function maskSecret(s) {
  const v = s === undefined || s === null ? '' : String(s);
  if (!v) return '';
  return v.length <= 12 ? v.slice(0, 4) + '****' : v.slice(0, 8) + '****' + v.slice(-4);
}
/**
 * 账号对外 DTO（全站唯一实现）：loginId/refreshToken/sid/辅助 Cookie 与恢复记录
 * 一律直接剔除，绝不展示片段；SESSDATA/bili_jct 沿用 maskSecret 片段。
 */
function maskAccount(a) {
  const account = a || {};
  const { refreshToken, sid, dedeUserID, dedeUserIDCheckMd5, refresh_csrf, qrcodeKey,
    cookies, credentials, newCredentials, oldCredentials, oldToken, result, ...safe } = account;
  return { ...safe, sessdata: maskSecret(account.sessdata), bili_jct: maskSecret(account.bili_jct), canAutoRefresh: Boolean(refreshToken) };
}
async function validateBiliCredentials(bili, credentials) {
  let info; try { info = await bili.getMyInfo(credentials.sessdata); } catch { throw new PassportError('nav', 'network'); }
  if (info.code !== 0) throw new PassportError('nav', 'business', info.code);
  const d = info.data || {}; const mid = String(d.mid || '');
  if (!/^\d+$/.test(mid) || (credentials.mid && mid !== String(credentials.mid))) throw new PassportError('nav', 'identity');
  return { mid, uid: d.mid, uname: d.uname || '', avatar: d.face || '' };
}
/**
 * 扫码落地 URL 域名白名单（2026-10 实测：B站已把扫码落地页从
 * passport.bilibili.com 迁移到 account.bilibili.com，两者均为官方域）。
 * 该 URL 仅用于渲染二维码图片，服务端轮询只依赖 qrcode_key，不访问此 URL。
 */
const QR_URL_HOSTS = new Set(['passport.bilibili.com', 'account.bilibili.com', 'www.bilibili.com']);
class PassportClient {
  constructor({ fetchImpl = fetch, timeoutMs = 15000 } = {}) { this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.controllers = new Set(); }
  close() { for (const c of this.controllers) c.abort(); }
  async request(stage, url, { credentials, form, html = false, signal } = {}) {
    const controller = new AbortController(); this.controllers.add(controller);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const timer = setTimeout(abort, this.timeoutMs);
    try {
      const headers = { 'user-agent': BILIBILI_UA, referer: 'https://www.bilibili.com/', accept: html ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*' };
      if (credentials) headers.cookie = cookieHeader(credentialsCookies(credentials));
      if (form) Object.assign(headers, { origin: 'https://www.bilibili.com', 'content-type': 'application/x-www-form-urlencoded' });
      const response = await this.fetch(url, { method: form ? 'POST' : 'GET', headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'error', signal: controller.signal });
      const setCookies = response.headers.getSetCookie();
      if (!response.ok) throw new PassportError(stage, [403, 412, 429].includes(response.status) ? 'restricted' : 'http', undefined, response.status);
      const chunks = []; let size = 0; const max = html ? 1048576 : 262144;
      for await (const chunk of response.body) { size += chunk.byteLength; if (size > max) { controller.abort(); throw new PassportError(stage, 'protocol'); } chunks.push(Buffer.from(chunk)); }
      const text = Buffer.concat(chunks).toString('utf8');
      if (html) return { text, setCookies };
      let json; try { json = JSON.parse(text); } catch { throw new PassportError(stage, 'protocol'); }
      if (!json || typeof json.code !== 'number') throw new PassportError(stage, 'protocol');
      if (json.code !== 0) throw new PassportError(stage, [-403, -509].includes(json.code) ? 'restricted' : 'business', json.code);
      return { json, setCookies };
    } catch (e) { if (e instanceof PassportError) throw e; throw new PassportError(stage, controller.signal.aborted ? 'timeout' : 'network'); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.controllers.delete(controller); }
  }
  async generateQr() {
    const { json } = await this.request('generate', 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
    const d = json.data; let url; try { url = new URL(d.url); } catch { throw new PassportError('generate', 'protocol'); }
    if (url.protocol !== 'https:' || !QR_URL_HOSTS.has(url.hostname) || url.username || url.password || typeof d.qrcode_key !== 'string' || !d.qrcode_key) throw new PassportError('generate', 'protocol');
    return { qrcodeKey: d.qrcode_key, url: url.href };
  }
  async pollQr(qrcodeKey, sessionCookies = {}) {
    const { json, setCookies } = await this.request('poll', 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?' + new URLSearchParams({ qrcode_key: qrcodeKey }));
    const d = json.data || {}; if (![0, 86101, 86090, 86038].includes(d.code)) throw new PassportError('poll', 'business', d.code);
    if (d.code !== 0) return { code: d.code };
    const responseCookies = parseSetCookies(setCookies, sessionCookies); let cookies = { ...responseCookies };
    if (!['SESSDATA', 'bili_jct', 'DedeUserID'].every(n => cookies[n])) {
      let url; try { url = new URL(d.url); } catch { throw new PassportError('poll', 'protocol'); }
      if (url.protocol !== 'https:' || !QR_URL_HOSTS.has(url.hostname) || url.username || url.password) throw new PassportError('poll', 'protocol');
      for (const name of COOKIE_NAMES) { const value = url.searchParams.get(name); if (!cookies[name] && value) cookies[name] = value; }
    }
    const credentials = newCredentials(cookies, d.refresh_token);
    return { code: 0, cookies, refreshToken: d.refresh_token, credentials };
  }
  async cookieInfo(credentials, signal) {
    const { json } = await this.request('info', 'https://passport.bilibili.com/x/passport-login/web/cookie/info?' + new URLSearchParams({ csrf: credentials.bili_jct }), { credentials, signal });
    if (typeof json.data?.refresh !== 'boolean' || !Number.isSafeInteger(json.data.timestamp) || json.data.timestamp <= 0) throw new PassportError('info', 'protocol');
    return json.data;
  }
  async getRefreshCsrf(credentials, correspondPath, signal) {
    if (!/^[0-9a-f]{256}$/.test(correspondPath)) throw new PassportError('correspond', 'protocol');
    const { text } = await this.request('correspond', `https://www.bilibili.com/correspond/1/${correspondPath}`, { credentials, html: true, signal });
    return extractRefreshCsrf(text);
  }
  async refreshCookie(credentials, { refreshCsrf, refreshToken, signal }) {
    const { json, setCookies } = await this.request('refresh', 'https://passport.bilibili.com/x/passport-login/web/cookie/refresh', { credentials, signal, form: { csrf: credentials.bili_jct, refresh_csrf: refreshCsrf, source: 'main_web', refresh_token: refreshToken } });
    const next = newCredentials(parseSetCookies(setCookies), json.data?.refresh_token);
    if (next.mid !== String(credentials.mid || credentials.uid)) throw new PassportError('refresh', 'identity');
    return next;
  }
  async confirmRefresh(credentials, oldRefreshToken, signal) {
    await this.request('confirm', 'https://passport.bilibili.com/x/passport-login/web/confirm/refresh', { credentials, signal, form: { csrf: credentials.bili_jct, refresh_token: oldRefreshToken } });
  }
}
module.exports = { PassportClient, PassportError, PUBLIC_KEY, parseSetCookies, buildCorrespondPath, extractRefreshCsrf, validateBiliCredentials, credentialsCookies, cookieHeader, newCredentials, maskSecret, maskAccount };
