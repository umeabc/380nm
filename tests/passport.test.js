const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const qrcode = require('qrcode');
const { PassportClient, PassportError, PUBLIC_KEY, parseSetCookies, buildCorrespondPath, extractRefreshCsrf } = require('../src/bilibili-passport');
const cookies = ['SESSDATA=new%2C=a; Expires=Wed, 01 Jan 2099 00:00:00 GMT; Domain=.bilibili.com', 'bili_jct=new-csrf', 'DedeUserID=42', 'sid=helper', 'DedeUserID__ckMd5=hash'];
const response = (data, lines = [], status = 200) => { const r = new Response(JSON.stringify(data), { status }); r.headers.getSetCookie = () => lines; return r; };
const old = { sessdata: 'old', bili_jct: 'old-csrf', mid: '42', refreshToken: 'old-token', sid: 'old-sid' };
test('固定1024公钥、OAEP SHA256、UTF8消息和256小写hex', () => {
  assert.equal(crypto.createPublicKey(PUBLIC_KEY).asymmetricKeyDetails.modulusLength, 1024);
  assert.match(buildCorrespondPath(1700000000000), /^[0-9a-f]{256}$/);
  buildCorrespondPath(1234, (options, input) => { assert.equal(options.key, PUBLIC_KEY); assert.equal(options.oaepHash, 'sha256'); assert.equal(options.padding, crypto.constants.RSA_PKCS1_OAEP_PADDING); assert.equal(input.toString('utf8'), 'refresh_1234'); return Buffer.alloc(128); });
  for (const n of [undefined, 0, -1, '1234', NaN]) assert.throws(() => buildCorrespondPath(n), PassportError);
});
test('Set-Cookie完整项、Expires逗号、等号、编码、删除、重复、辅助白名单', () => {
  const got = parseSetCookies(cookies); assert.equal(got.SESSDATA, 'new%2C=a'); assert.equal(got.sid, 'helper');
  assert.equal(parseSetCookies(['sid=one', 'sid=two']).sid, 'two');
  assert.deepEqual(parseSetCookies(['sid=one', 'sid=x; Max-Age=0']), {});
  assert.deepEqual(parseSetCookies(['sid=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT']), {});
  assert.deepEqual(parseSetCookies(['bad=x', 'sid=x; Domain=evil.test']), {});
  assert.throws(() => parseSetCookies(['sid=x\r\nfoo=x']), PassportError);
});
test('HTML唯一div严格提取、单双引号、属性/空白、无脚本执行', () => {
  assert.equal(extractRefreshCsrf(`<script>throw 1</script><div class='x' id = '1-name'> value </div>`), 'value');
  for (const html of ['', '<div id="1-name"> </div>', '<div id="1-name">a</div><div id="1-name">b</div>']) assert.throws(() => extractRefreshCsrf(html), PassportError);
});
test('qrcode精确生产依赖生成PNG dataURL', async () => {
  assert.equal(require('qrcode/package.json').version, '1.5.4');
  const data = await qrcode.toDataURL('https://passport.bilibili.com/fake', { width: 256 });
  assert.match(data, /^data:image\/png;base64,/); const png = Buffer.from(data.split(',')[1], 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG'); assert.equal(png.readUInt32BE(16), 256);
});
test('四态poll外层code与data.code独立处理、Cookie主导及受限URL兜底', async () => {
  for (const code of [86101, 86090, 86038]) { const p = new PassportClient({ fetchImpl: async () => response({ code: 0, data: { code } }) }); assert.equal((await p.pollQr('fake')).code, code); }
  const p = new PassportClient({ fetchImpl: async () => response({ code: 0, data: { code: 0, url: 'https://www.bilibili.com/?bili_jct=fallback&DedeUserID=42&SESSDATA=ignored', refresh_token: 'token' } }, ['SESSDATA=header%2Cvalue']) });
  const got = await p.pollQr('fake'); assert.equal(got.credentials.sessdata, 'header%2Cvalue'); assert.equal(got.credentials.bili_jct, 'fallback');
  for (const data of [{ code: -101 }, { code: 0, data: { code: 0, url: 'https://evil.test/?SESSDATA=x', refresh_token: 't' } }, { code: 0, data: { code: 0 } }]) {
    await assert.rejects(new PassportClient({ fetchImpl: async () => response(data) }).pollQr('fake'), PassportError);
  }
});
test('generate/poll 落地 URL 白名单：account.bilibili.com 新域接受、非官方域拒绝', async () => {
  const ok = new PassportClient({ fetchImpl: async () => response({ code: 0, data: { url: 'https://account.bilibili.com/h5/account-h5/auth/scan-web?navhide=1&qrcode_key=k', qrcode_key: 'k' } }) });
  const got = await ok.generateQr(); assert.equal(got.qrcodeKey, 'k');
  const okPoll = new PassportClient({ fetchImpl: async () => response({ code: 0, data: { code: 0, url: 'https://account.bilibili.com/scan?DedeUserID=42&SESSDATA=s&bili_jct=j', refresh_token: 't' } }, ['SESSDATA=header']) });
  const poll = await okPoll.pollQr('k'); assert.equal(poll.credentials.bili_jct, 'j');
  for (const host of ['evil.test', 'bilibili.com.evil.test']) {
    await assert.rejects(new PassportClient({ fetchImpl: async () => response({ code: 0, data: { url: `https://${host}/x?qrcode_key=k`, qrcode_key: 'k' } }) }).generateQr(), e => e.kind === 'protocol');
  }
});
test('五步请求指纹、完整Cookie、form和confirm旧token新csrf', async () => {
  const requests = [];
  const p = new PassportClient({ fetchImpl: async (url, options) => { requests.push({ url, options });
    if (url.includes('/info?')) return response({ code: 0, data: { refresh: true, timestamp: 1234 } });
    if (url.includes('/correspond/')) { const r = new Response('<div id="1-name">csrf-html</div>'); r.headers.getSetCookie = () => []; return r; }
    if (url.endsWith('/cookie/refresh')) return response({ code: 0, data: { refresh_token: 'new-token' } }, cookies);
    return response({ code: 0 });
  } });
  await p.cookieInfo(old); const csrf = await p.getRefreshCsrf(old, buildCorrespondPath(1234));
  const next = await p.refreshCookie(old, { refreshCsrf: csrf, refreshToken: old.refreshToken }); await p.confirmRefresh(next, old.refreshToken);
  assert.equal(requests.length, 4);
  for (const { options } of requests) { assert.match(options.headers['user-agent'], /Chrome\/126/); assert.equal(options.headers.referer, 'https://www.bilibili.com/'); assert.equal(options.redirect, 'error'); }
  assert.match(requests[0].options.headers.cookie, /DedeUserID=42; sid=old-sid/);
  const form = new URLSearchParams(requests[2].options.body); assert.equal(form.get('refresh_token'), 'old-token'); assert.equal(form.get('csrf'), 'old-csrf'); assert.equal(form.get('source'), 'main_web');
  const confirm = new URLSearchParams(requests[3].options.body); assert.equal(confirm.get('csrf'), 'new-csrf'); assert.equal(confirm.get('refresh_token'), 'old-token'); assert.match(requests[3].options.headers.cookie, /SESSDATA=new%2C=a/);
});
test('HTTP非2xx即失败、风控分类、非法JSON/超限及真实Abort', async () => {
  for (const status of [403, 412, 429, 500]) await assert.rejects(new PassportClient({ fetchImpl: async () => response({ code: 0 }, [], status) }).generateQr(), e => e.httpStatus === status && !JSON.stringify(e).includes('token'));
  for (const text of ['broken', 'x'.repeat(262145)]) { const r = new Response(text); r.headers.getSetCookie = () => []; await assert.rejects(new PassportClient({ fetchImpl: async () => r }).generateQr(), e => e.kind === 'protocol'); }
  let aborted = false;
  const p = new PassportClient({ timeoutMs: 10, fetchImpl: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('secret-token')); })) });
  await assert.rejects(p.generateQr(), e => e.kind === 'timeout' && !JSON.stringify(e).includes('secret-token')); assert.equal(aborted, true);
});
