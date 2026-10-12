/* 测试：账号扫码登录 / DTO 脱敏 / 三路径迁移 / 路由鉴权（真实 Express + 临时 DATA_DIR + 假上游） */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const express = require('express');
const { Store } = require('../src/store');
const { AccountCredentialsLock } = require('../src/account-credentials-lock');
const { CookieRefreshService } = require('../src/cookie-refresh');
const { QrLoginService } = require('../src/qrcode-login');
const createRoutes = require('../src/routes');

const QR_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/fake-login-url';
const QR_KEY = 'fake-qrcode-key';
// 金丝雀：全部为虚构值，仅用于断言「绝不外发/绝不进日志」
const CANARY = { sessdata: 'CANSESSDATA0001', bili_jct: 'CANCSRF0001', refreshToken: 'CANTOKEN0001', sid: 'CANSID0001', md5: 'CANMD50001' };

function credentialsFor(mid, tag = 'qr') {
  return {
    sessdata: `${tag}-sessdata-${mid}`, bili_jct: `${tag}-csrf-${mid}`, mid: String(mid),
    refreshToken: `${tag}-token-${mid}`, sid: `${tag}-sid-${mid}`, dedeUserIDCheckMd5: `${tag}-md5-${mid}`
  };
}

async function harness(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '380nm-acc-'));
  const store = new Store(path.join(dir, 'db.json'));
  await store.init();
  for (const id of ['u1', 'u2']) {
    store.data.users.push({ id, username: id, name: id, role: 'user', active: true, passwordHash: 'fake', createdAt: new Date().toISOString() });
  }
  await store.flushNow();
  const sid = { u1: store.createSession('u1'), u2: store.createSession('u2') };

  const calls = [];
  let now = Date.now();
  let info = async (sessdata) => ({ code: 0, data: { mid: Number(String(sessdata).replace(/\D/g, '')) || 42, uname: '昵称', face: '' } });
  let pollScript = async () => ({ code: 86101 });
  const bili = { getMyInfo: (sessdata) => info(sessdata) };
  const passport = {
    generateQr: async () => { calls.push('generate'); return { qrcodeKey: QR_KEY, url: QR_URL }; },
    pollQr: () => pollScript()
  };
  const qrcode = { toDataURL: async (url) => { assert.ok(url.startsWith('https://passport.bilibili.com/'), '只应把官方登录 URL 交给 qrcode'); return 'data:image/png;base64,AAAA'; } };
  const lock = new AccountCredentialsLock();
  const refresh = new CookieRefreshService({ store, passport, bili, lock, dataDir: dir });
  const qr = new QrLoginService({ store, passport, bili, lock, qrcode, refresh, clock: () => now });
  const storage = { name: 'local', dir: path.join(dir, 'uploads'), cfg: {} };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createRoutes({ store, storage, bili, credentialsLock: lock, qrLogin: qr, cookieRefresh: refresh }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await qr.close();
    await refresh.close();
    await store.flushNow().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const request = async (method, url, { user = 'u1', body, headers = {} } = {}) => {
    const init = { method, headers: { ...(user ? { cookie: `sid=${sid[user]}` } : {}) } };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) init.headers['content-type'] = 'application/json';
    Object.assign(init.headers, headers);
    const response = await fetch(base + url, init);
    let json = null; try { json = await response.json(); } catch (e) { /* 非 JSON */ }
    return { status: response.status, json, text: JSON.stringify(json), headers: response.headers };
  };
  return {
    dir, store, sid, qr, refresh, lock, request, calls,
    advance: (ms) => { now += ms; },
    setInfo: (fn) => { info = fn; },
    setPoll: (fn) => { pollScript = fn; },
    addAccount: async (patch) => { const a = { id: patch.id || `acc_${Math.random().toString(16).slice(2, 8)}`, userId: patch.userId || 'u1', name: patch.name || '账号', uid: patch.uid, mid: patch.mid, sessdata: patch.sessdata || 'sess', bili_jct: patch.bili_jct || 'csrf', createdAt: patch.createdAt || '2020-01-01T00:00:00.000Z', ...patch }; await store.addAccount(a); await store.flushNow(); return a; }
  };
}

/* ---------------- 鉴权 / 同源 / 限流 ---------------- */

test('QR 端点：未登录401、非同源JSON 400、生成只回脱敏DTO、生成限流429', async (t) => {
  const h = await harness(t);
  assert.equal((await h.request('POST', '/accounts/qrcode', { user: null, body: {} })).status, 401);
  assert.equal((await h.request('GET', '/accounts/qrcode/x/poll', { user: null })).status, 401);
  assert.equal((await h.request('POST', '/accounts/qrcode', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 400);
  assert.equal((await h.request('POST', '/accounts/qrcode', { body: {}, headers: { origin: 'http://evil.test' } })).status, 400);
  assert.equal((await h.request('POST', '/accounts/qrcode', { body: { nope: 1 } })).status, 400);

  const ok = await h.request('POST', '/accounts/qrcode', { body: { name: '主号' } });
  assert.equal(ok.status, 200);
  assert.match(ok.json.loginId, /^[0-9a-f]{48}$/);
  assert.equal(ok.json.qrImage, 'data:image/png;base64,AAAA');
  assert.ok(Number.isFinite(Date.parse(ok.json.expiresAt)));
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.ok(!ok.text.includes(QR_KEY), '不得外发 qrcode_key');
  assert.ok(!ok.text.includes('qrcode/fake-login-url'), '不得外发原始登录 URL');
  assert.deepEqual(Object.keys(ok.json).sort(), ['expiresAt', 'loginId', 'qrImage']);

  assert.equal((await h.request('POST', '/accounts/qrcode', { body: {} })).status, 429, '同用户 10 秒内不得重复生成');
  const other = await h.request('POST', '/accounts/qrcode', { body: {}, user: 'u2' });
  assert.equal(other.status, 200, '限流按用户隔离');
});

test('poll：四态映射、跨用户404、不存在404、指定账号不可见404', async (t) => {
  const h = await harness(t);
  const gen = (await h.request('POST', '/accounts/qrcode', { body: {} })).json;
  h.setPoll(async () => ({ code: 86101 }));
  assert.deepEqual((await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`)).json, { status: 'waiting', code: 86101 });
  h.setPoll(async () => ({ code: 86090 }));
  assert.deepEqual((await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`)).json, { status: 'waiting', code: 86101 }, '2 秒内的上游最短间隔内返回当前状态，不重复打上游');
  h.advance(2100);
  assert.deepEqual((await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`)).json, { status: 'scanned', code: 86090 });
  h.setPoll(async () => ({ code: 86038 }));
  h.advance(2100);
  assert.deepEqual((await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`)).json, { status: 'expired', code: 86038 });
  assert.equal((await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`)).status, 200, '过期是 200 状态机，不是 404');
  assert.equal((await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`, { user: 'u2' })).status, 404, '跨用户 loginId');
  assert.equal((await h.request('GET', '/accounts/qrcode/deadbeef/poll')).status, 404);
  assert.equal((await h.request('POST', '/accounts/qrcode', { body: { accountId: 'acc_other' } })).status, 404, 'accountId 必须 canTouch');
});

/* ---------------- 迁移三路径 ---------------- */

test('扫码成功：首次新增落库、DTO 无秘密、并发 poll 只保存一次', async (t) => {
  const h = await harness(t);
  const gen = (await h.request('POST', '/accounts/qrcode', { body: { name: '主号' } })).json;
  const cred = credentialsFor(42, 'qr');
  h.setPoll(async () => ({ code: 0, cookies: {}, refreshToken: cred.refreshToken, credentials: cred }));
  const [a, b] = await Promise.all([
    h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`),
    h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`)
  ]);
  for (const r of [a, b]) {
    assert.equal(r.json.status, 'success');
    assert.equal(r.json.code, 0);
    assert.equal(r.json.updatedExisting, false);
    assert.equal(r.json.account.mid, '42');
    assert.equal(r.json.account.canAutoRefresh, true);
    for (const secret of [cred.sessdata, cred.bili_jct, cred.refreshToken, cred.sid, cred.dedeUserIDCheckMd5]) assert.ok(!r.text.includes(secret), '响应不得包含任何登录链凭据');
  }
  assert.equal(h.store.listAccounts().length, 1);
  const saved = h.store.listAccounts()[0];
  assert.equal(saved.refreshToken, cred.refreshToken, 'refreshToken 必须落库');
  assert.equal(saved.userId, 'u1');
  assert.match(saved.id, /^acc_/);
  const replay = await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`);
  assert.equal(replay.json.status, 'success');
  assert.equal(h.store.listAccounts().length, 1, '重复 poll 不得重复落库');
});

test('扫码迁移：同 mid 原地更新保留 id/createdAt/备注，旧账号仅 uid 也能兜底命中', async (t) => {
  const h = await harness(t);
  const legacy = await h.addAccount({ id: 'acc_legacy', uid: 42, name: '备注保留', sessdata: 'old-sess', bili_jct: 'old-csrf', dedeUserIDCheckMd5: CANARY.md5 });
  const gen = (await h.request('POST', '/accounts/qrcode', { body: {} })).json;
  const cred = credentialsFor(42, 'qr');
  h.setPoll(async () => ({ code: 0, cookies: {}, refreshToken: cred.refreshToken, credentials: cred }));
  const r = await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`);
  assert.equal(r.json.updatedExisting, true);
  assert.equal(r.json.account.id, 'acc_legacy');
  assert.equal(r.json.account.name, '备注保留');
  const saved = h.store.getAccount('acc_legacy');
  assert.equal(h.store.listAccounts().length, 1);
  assert.equal(saved.createdAt, legacy.createdAt);
  assert.equal(saved.sessdata, cred.sessdata);
  assert.equal(saved.mid, '42');
  assert.equal(saved.sid, cred.sid);
  assert.equal(saved.dedeUserIDCheckMd5, cred.dedeUserIDCheckMd5, '新链辅助Cookie应同组更新');
});

test('扫码安全：同用户重复 mid 409、指定账号身份不符 409 且不改动原凭据', async (t) => {
  const h = await harness(t);
  await h.addAccount({ id: 'acc_a1', mid: '42', uid: 42 });
  await h.addAccount({ id: 'acc_a2', mid: '42', uid: 42 });
  const target = await h.addAccount({ id: 'acc_b7', userId: 'u2', mid: '7', uid: 7, sessdata: 'b7-sess', bili_jct: 'b7-csrf' });
  const cred = credentialsFor(42, 'qr');
  h.setPoll(async () => ({ code: 0, cookies: {}, refreshToken: cred.refreshToken, credentials: cred }));

  const gen = (await h.request('POST', '/accounts/qrcode', { body: {} })).json;
  const dup = await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`);
  assert.equal(dup.status, 409, '通用扫码遇到重复 mid 必须 409');
  assert.equal(h.store.listAccounts().length, 3);

  // 指定账号「扫码更新」但身份不符：409，且原凭据一字不改
  const gen2 = (await h.request('POST', '/accounts/qrcode', { body: { accountId: 'acc_b7' }, user: 'u2' })).json;
  const mismatch = await h.request('GET', `/accounts/qrcode/${gen2.loginId}/poll`, { user: 'u2' });
  assert.equal(mismatch.status, 409);
  assert.equal(h.store.getAccount('acc_b7').sessdata, target.sessdata);
  assert.equal(h.store.getAccount('acc_b7').refreshToken, undefined);
});

test('扫码安全：跨用户同 mid 允许各自独立绑定，绝不更新他人账号', async (t) => {
  const h = await harness(t);
  const other = await h.addAccount({ id: 'acc_b7', userId: 'u2', mid: '7', uid: 7, sessdata: 'b7-sess', bili_jct: 'b7-csrf' });
  h.setInfo(async () => ({ code: 0, data: { mid: 7, uname: '甲', face: '' } }));
  const cred = credentialsFor(7, 'u1qr');
  h.setPoll(async () => ({ code: 0, cookies: {}, refreshToken: cred.refreshToken, credentials: cred }));
  const gen = (await h.request('POST', '/accounts/qrcode', { body: {} })).json;
  const r = await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`);
  assert.equal(r.json.updatedExisting, false, '别人同 mid 的账号不得原地更新');
  assert.equal(h.store.getAccount('acc_b7').sessdata, other.sessdata);
  assert.equal(h.store.getAccount('acc_b7').refreshToken, undefined);
  assert.equal(h.store.listAccounts().filter((a) => a.userId === 'u1').length, 1);
});

test('扫码安全：nav 身份不一致、缺 refresh_token 均不落半成品账号', async (t) => {
  const h = await harness(t);
  h.setInfo(async () => ({ code: 0, data: { mid: 99, uname: '别人', face: '' } }));
  const gen = (await h.request('POST', '/accounts/qrcode', { body: {} })).json;
  const cred = credentialsFor(42, 'qr');
  h.setPoll(async () => ({ code: 0, cookies: {}, refreshToken: cred.refreshToken, credentials: cred }));
  const mismatch = await h.request('GET', `/accounts/qrcode/${gen.loginId}/poll`);
  assert.equal(mismatch.status, 409);
  assert.equal(h.store.listAccounts().length, 0);

  const gen2 = (await h.request('POST', '/accounts/qrcode', { body: {}, user: 'u2' })).json;
  h.setInfo(async () => ({ code: 0, data: { mid: 42, uname: '本人', face: '' } }));
  h.setPoll(async () => ({ code: 0, cookies: {}, refreshToken: undefined, credentials: undefined }));
  const missing = await h.request('GET', `/accounts/qrcode/${gen2.loginId}/poll`, { user: 'u2' });
  assert.equal(missing.status, 502);
  assert.equal(h.store.listAccounts().length, 0, '缺凭据绝不半落库');
});

/* ---------------- DTO 脱敏 ---------------- */

test('列表与全部账号响应脱敏：剔除 refreshToken/sid/md5，只留 canAutoRefresh 与片段', async (t) => {
  const h = await harness(t);
  await h.addAccount({
    id: 'acc_secret', mid: '42', uid: 42, sessdata: CANARY.sessdata, bili_jct: CANARY.bili_jct,
    refreshToken: CANARY.refreshToken, sid: CANARY.sid, dedeUserIDCheckMd5: CANARY.md5
  });
  const list = await h.request('GET', '/accounts');
  assert.equal(list.status, 200);
  assert.equal(list.json.accounts.length, 1);
  const a = list.json.accounts[0];
  assert.equal(a.canAutoRefresh, true);
  assert.equal(a.mid, '42');
  assert.equal(a.refreshToken, undefined);
  assert.equal(a.sid, undefined);
  assert.equal(a.dedeUserIDCheckMd5, undefined);
  assert.equal(a.sessdata, 'CANSESSD****0001');
  assert.equal(a.bili_jct, 'CANC****');
  for (const secret of [CANARY.refreshToken, CANARY.sid, CANARY.md5]) assert.ok(!list.text.includes(secret), '列表不得含秘密');
  assert.equal((await h.request('GET', '/accounts', { user: 'u2' })).json.accounts.length, 0, '跨用户不可见');
});

/* ---------------- 手动添加 / 重新校验 / 修改 Cookie ---------------- */

test('手动添加补 mid；重新校验补 mid 且 nav 成功不清除 refreshError', async (t) => {
  const h = await harness(t);
  h.setInfo(async () => ({ code: 0, data: { mid: 42, uname: '昵称', face: 'http://face' } }));
  const add = await h.request('POST', '/accounts', { body: { name: '手动', sessdata: 'manual-sess', bili_jct: 'manual-csrf' } });
  assert.equal(add.status, 200);
  assert.equal(add.json.account.mid, '42');
  assert.equal(add.json.account.canAutoRefresh, false);
  assert.equal(add.json.account.refreshToken, undefined);

  const legacy = await h.addAccount({ id: 'acc_old', uid: 42, sessdata: 'legacy-sess', bili_jct: 'legacy-csrf' });
  await h.store.updateAccount('acc_old', { cookieStatus: { ok: false, code: 'pendingConfirm', message: '新Cookie已取得，确认旧链失败', checkedAt: '2026-01-01T00:00:00.000Z', refreshError: { code: 'pendingConfirm', message: '新Cookie已取得，确认旧链失败', at: '2026-01-01T00:00:00.000Z', needsRescan: false } } });
  const rev = await h.request('POST', '/accounts/acc_old/reverify');
  assert.equal(rev.status, 200);
  assert.equal(rev.json.account.mid, '42');
  assert.equal(rev.json.account.cookieStatus.ok, false, 'nav 成功不得把续期异常刷绿');
  assert.match(rev.json.account.cookieStatus.message, /^Cookie有效，但自动续期失败：/);
  assert.equal(rev.json.account.cookieStatus.refreshError.code, 'pendingConfirm');
  assert.equal(legacy.id, 'acc_old');
});

test('重新校验失败：中文安全原因、原凭据不变、refreshError 保留', async (t) => {
  const h = await harness(t);
  await h.addAccount({ id: 'acc_bad', uid: 42, sessdata: 'bad-sess', bili_jct: 'bad-csrf', refreshToken: 'fake-keep-token' });
  await h.store.updateAccount('acc_bad', { cookieStatus: { ok: true, refreshError: { code: 'info', message: '续期检查网络失败，将在下次检查时再试', at: 'x', needsRescan: false } } });
  h.setInfo(async () => ({ code: -101, message: '账号未登录' }));
  const r = await h.request('POST', '/accounts/acc_bad/reverify');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'Cookie已失效，请扫码更新');
  assert.ok(!r.text.includes('账号未登录'), '不得回显上游 message');
  const acc = h.store.getAccount('acc_bad');
  assert.equal(acc.sessdata, 'bad-sess');
  assert.equal(acc.refreshToken, 'fake-keep-token', 'nav 失败保留 token');
  assert.equal(acc.cookieStatus.ok, false);
  assert.equal(acc.cookieStatus.refreshError.code, 'info');

  h.setInfo(async () => { throw new Error('socket hang up'); });
  const r2 = await h.request('POST', '/accounts/acc_bad/reverify');
  assert.equal(r2.status, 502);
  assert.equal(r2.json.error, '网络异常，无法连接B站');
});

test('修改 Cookie：字段白名单、同身份约束、留空语义、失败不覆盖', async (t) => {
  const h = await harness(t);
  await h.addAccount({ id: 'acc_c', mid: '42', uid: 42, sessdata: 'old-sess', bili_jct: 'old-csrf', refreshToken: 'old-token', sid: 'old-sid', dedeUserIDCheckMd5: 'old-md5' });
  h.setInfo(async () => ({ code: 0, data: { mid: 42, uname: '昵称', face: '' } }));

  assert.equal((await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 's', bili_jct: 'c', mid: '99' } })).status, 400, '客户端不得覆盖 mid');
  assert.equal((await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 's', bili_jct: 'c', userId: 'u2' } })).status, 400);
  assert.equal((await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 's', bili_jct: 'c', refreshToken: 5 } })).status, 400);
  assert.equal((await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 's', bili_jct: 'c\r\nX: 1' } })).status, 400);

  // Cookie 完全未变 + token 留空 → 保留原链
  const same = await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 'old-sess', bili_jct: 'old-csrf' } });
  assert.equal(same.status, 200);
  assert.equal(h.store.getAccount('acc_c').refreshToken, 'old-token');
  assert.equal(h.store.getAccount('acc_c').cookieStatus.ok, true);

  // Cookie 改变 + token 留空 → 清除旧链与旧辅助 Cookie
  const changed = await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 'new-sess', bili_jct: 'new-csrf' } });
  assert.equal(changed.status, 200);
  let acc = h.store.getAccount('acc_c');
  assert.equal(acc.sessdata, 'new-sess');
  assert.equal(acc.refreshToken, undefined);
  assert.equal(acc.sid, undefined);
  assert.equal(acc.dedeUserIDCheckMd5, undefined);
  assert.equal(changed.json.account.canAutoRefresh, false);
  assert.equal(JSON.parse(await fsp.readFile(h.store.file, 'utf8')).accounts[0].refreshToken, undefined, '落盘后也不得残留旧 token');

  // 新 token + 重置每日门禁
  await h.store.updateAccount('acc_c', { lastCookieRefreshAt: '2026-01-01T00:00:00.000Z' });
  const withToken = await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 'new-sess', bili_jct: 'new-csrf', refreshToken: 'fake-new-token' } });
  assert.equal(withToken.status, 200);
  acc = h.store.getAccount('acc_c');
  assert.equal(acc.refreshToken, 'fake-new-token');
  assert.equal(acc.lastCookieRefreshAt, undefined, '新登录链重置每日门禁');
  assert.equal(withToken.json.account.canAutoRefresh, true);
  assert.ok(!withToken.text.includes('fake-new-token'), '响应不得回显 token');

  // 另一 B 站身份 → 400 且不改绑
  h.setInfo(async () => ({ code: 0, data: { mid: 99, uname: '别人', face: '' } }));
  const other = await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 'other-sess', bili_jct: 'other-csrf', refreshToken: 'other-token' } });
  assert.equal(other.status, 400);
  assert.equal(other.json.error, '不能修改为另一B站身份，请新增账号');
  acc = h.store.getAccount('acc_c');
  assert.equal(acc.sessdata, 'new-sess');
  assert.equal(acc.refreshToken, 'fake-new-token');

  // 校验失败（-101）→ 保留原凭据与 refreshError
  h.setInfo(async () => ({ code: -101, message: 'x' }));
  const failed = await h.request('PUT', '/accounts/acc_c/cookie', { body: { sessdata: 'dead-sess', bili_jct: 'dead-csrf' } });
  assert.equal(failed.status, 400);
  acc = h.store.getAccount('acc_c');
  assert.equal(acc.sessdata, 'new-sess');
  assert.equal(acc.refreshToken, 'fake-new-token');
  assert.equal(acc.cookieStatus.ok, false);
  assert.equal(acc.cookieStatus.message, 'Cookie已失效，请扫码更新');
});

test('修改 Cookie 后清理该账号恢复记录；删除账号同样清理且写盘', async (t) => {
  const h = await harness(t);
  await h.addAccount({ id: 'acc_p', mid: '42', uid: 42, sessdata: 's', bili_jct: 'c', refreshToken: 'old-token' });
  await h.refresh.loaded;
  await h.refresh.writeRecords((r) => { r.acc_p = { accountId: 'acc_p', oldToken: 'old-token', oldCredentials: { sessdata: 's', bili_jct: 'c', refreshToken: 'old-token' }, newCredentials: { sessdata: 'n', bili_jct: 'nc', refreshToken: 'new-token' }, stage: 'prepared', createdAt: 'x' }; });
  h.setInfo(async () => ({ code: 0, data: { mid: 42, uname: 'n', face: '' } }));
  const r = await h.request('PUT', '/accounts/acc_p/cookie', { body: { sessdata: 's2', bili_jct: 'c2' } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(h.dir, 'cookie-refresh-pending.json'), 'utf8')), {});

  const del = await h.request('DELETE', '/accounts/acc_p');
  assert.equal(del.status, 200);
  assert.equal(h.store.getAccount('acc_p'), undefined);
  assert.equal(JSON.parse(await fsp.readFile(h.store.file, 'utf8')).accounts.length, 0, '删除必须立即落盘');
});

test('下线账号不允许跨用户删除/修改；任务引用的账号删除被拒绝', async (t) => {
  const h = await harness(t);
  await h.addAccount({ id: 'acc_u1', mid: '1', uid: 1 });
  assert.equal((await h.request('DELETE', '/accounts/acc_u1', { user: 'u2' })).status, 404);
  assert.equal((await h.request('PUT', '/accounts/acc_u1/cookie', { user: 'u2', body: { sessdata: 's', bili_jct: 'c' } })).status, 404);
  await h.store.addJob({ id: 'job_1', accountId: 'acc_u1', userId: 'u1', status: 'pending' });
  const del = await h.request('DELETE', '/accounts/acc_u1');
  assert.equal(del.status, 400);
  assert.match(del.json.error, /待发布/);
});
