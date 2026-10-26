/* 测试：登录失败限速 —— 双维度、成功清零、窗口过期、Map 有界、配置校验 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const { Store } = require('../src/store');
const { hashPassword } = require('../src/auth');
const { LoginThrottle } = require('../src/login-throttle');
const createRoutes = require('../src/routes');

async function harness(t, { throttleOptions = {}, trustProxy = false } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '380nm-login-'));
  const store = new Store(path.join(dir, 'db.json'));
  await store.init();
  store.data.users = [
    { id: 'usr_a', username: 'alice', name: 'Alice', role: 'admin', active: true, passwordHash: hashPassword('correct-horse'), createdAt: new Date().toISOString() },
    { id: 'usr_b', username: 'bob', name: 'Bob', role: 'user', active: true, passwordHash: hashPassword('bob-pass'), createdAt: new Date().toISOString() }
  ];
  await store.flushNow();

  let now = Date.now();
  const throttle = new LoginThrottle({ maxFailures: 3, maxFailuresIp: 20, windowMs: 60_000, maxEntries: 500, now: () => now, ...throttleOptions });

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/api', createRoutes({ store, storage: { name: 'local', dir }, loginThrottle: throttle }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    await store.flushNow().catch(() => {});
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const login = async (username, password, headers = {}) => {
    const response = await fetch(base + '/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username, password })
    });
    let json = null; try { json = await response.json(); } catch (e) { /* ignore */ }
    return { status: response.status, json, retryAfter: response.headers.get('retry-after') };
  };
  return { store, throttle, login, advance: (ms) => { now += ms; }, base };
}

test('连续失败达阈值后 429 + Retry-After，且不泄露用户名是否存在', async (t) => {
  const h = await harness(t);
  const bad = [];
  for (let i = 0; i < 3; i++) bad.push(await h.login('alice', 'wrong'));
  for (const r of bad) {
    assert.equal(r.status, 401);
    assert.equal(r.json.error, '用户名或密码错误', '401 文案保持通用');
  }
  const blocked = await h.login('alice', 'wrong');
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error, /登录失败次数过多/);
  assert.ok(Number(blocked.retryAfter) > 0, 'Retry-After 必须是正整数秒');
  assert.ok(Number(blocked.retryAfter) <= 60);

  // 用户不存在也走同一套限速与文案，不泄露用户名是否存在
  const unknown = [];
  for (let i = 0; i < 3; i++) unknown.push(await h.login('nobody', 'x'));
  for (const r of unknown) {
    assert.equal(r.status, 401);
    assert.equal(r.json.error, '用户名或密码错误');
  }
  assert.equal((await h.login('nobody', 'x')).status, 429);
});

test('成功登录清零计数（用户名维度），被限速的请求不吃 scrypt', async (t) => {
  const h = await harness(t);
  for (let i = 0; i < 2; i++) assert.equal((await h.login('alice', 'wrong')).status, 401);
  const ok = await h.login('alice', 'correct-horse');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.user.username, 'alice');
  assert.equal(h.throttle.size().users, 0, '成功登录清掉该用户名的计数');
  // 清零后再失败 3 次才重新触发限速
  for (let i = 0; i < 3; i++) assert.equal((await h.login('alice', 'wrong')).status, 401);
  assert.equal((await h.login('alice', 'wrong')).status, 429);
});

test('窗口过期后恢复；限速期间不累加失败，窗口不会被持续爆破无限延长', async (t) => {
  const h = await harness(t, { throttleOptions: { windowMs: 10_000 } });
  for (let i = 0; i < 3; i++) assert.equal((await h.login('alice', 'wrong')).status, 401);
  const blocked = await h.login('alice', 'wrong');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retryAfter) <= 10);

  // 在窗口内持续请求（被限速），不得把窗口往后推
  h.advance(9_000);
  assert.equal((await h.login('alice', 'wrong')).status, 429);
  h.advance(1_100); // 超过首个失败起的窗口
  assert.equal((await h.login('alice', 'wrong')).status, 401, '窗口过期后恢复为正常校验');

  h.advance(10_000);
  assert.equal((await h.login('alice', 'correct-horse')).status, 200);
});

test('IP 维度挡住换用户名爆破，但同一 IP 的正常用户不被拖死', async (t) => {
  const h = await harness(t, { throttleOptions: { maxFailures: 100, maxFailuresIp: 4 } });
  // 同 IP 换着用户名猜：第 5 次起按 IP 拦截
  for (let i = 0; i < 4; i++) assert.equal((await h.login(`guess${i}`, 'x')).status, 401);
  const blocked = await h.login('guess9', 'x');
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.retryAfter) > 0);

  // 用户名维度独立：一个用户被限速不会直接连坐同 IP 的另一个用户（阈值没有叠加）
  const h2 = await harness(t, { throttleOptions: { maxFailures: 3, maxFailuresIp: 100 } });
  for (let i = 0; i < 3; i++) assert.equal((await h2.login('alice', 'wrong')).status, 401);
  assert.equal((await h2.login('alice', 'wrong')).status, 429);
  assert.equal((await h2.login('bob', 'bob-pass')).status, 200, 'NAT 后的另一位正常用户仍可登录');

  // 成功登录只清用户名维度：持有一个合法账号不能反复重置 IP 计数去爆破别人
  const h3 = await harness(t, { throttleOptions: { maxFailures: 100, maxFailuresIp: 3 } });
  assert.equal((await h3.login('alice', 'wrong')).status, 401);
  assert.equal((await h3.login('alice', 'correct-horse')).status, 200);
  assert.equal(h3.throttle.size().users, 0, '成功登录清掉用户名计数');
  assert.equal(h3.throttle.size().ips, 1, 'IP 计数在成功登录后仍保留，直到窗口过期');
});

test('Map 有界：条数上限 + 过期清理', async (t) => {
  const h = await harness(t, { throttleOptions: { maxEntries: 8, maxFailures: 2, maxFailuresIp: 2 } });
  for (let i = 0; i < 50; i++) h.throttle.fail(`10.0.0.${i}`, `user${i}`);
  const size = h.throttle.size();
  assert.ok(size.users <= 8, `用户名桶应有界，实际 ${size.users}`);
  assert.ok(size.ips <= 8, `IP 桶应有界，实际 ${size.ips}`);

  // 过期后 check 应清掉旧桶，不会阻止新请求
  h.advance(120_000);
  assert.deepEqual(h.throttle.check('10.0.0.250', 'fresh'), { allowed: true, retryAfterSec: 0 });
});

test('TRUST_PROXY 默认关闭：X-Forwarded-For 不参与 IP 判定；显式开启后按真实 IP', async (t) => {
  // 默认：伪造 XFF 换 IP 无效，IP 维度仍按 socket 地址累计
  const off = await harness(t, { throttleOptions: { maxFailures: 100, maxFailuresIp: 3 } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await off.login(`guess${i}`, 'wrong', { 'x-forwarded-for': `1.2.3.${i}` })).status, 401);
  }
  assert.equal((await off.login('guess9', 'wrong', { 'x-forwarded-for': '9.9.9.9' })).status, 429,
    '默认不信任 XFF，换个伪造 IP 也照样被 IP 维度拦住');

  // 显式 opt-in：不同 XFF 视为不同来源（由反代负责清洗）
  const on = await harness(t, { trustProxy: true, throttleOptions: { maxFailures: 100, maxFailuresIp: 3 } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await on.login(`guess${i}`, 'wrong', { 'x-forwarded-for': '1.2.3.0' })).status, 401);
  }
  assert.equal((await on.login('guess9', 'wrong', { 'x-forwarded-for': '9.9.9.9' })).status, 401,
    '开启 trust proxy 后新 IP 有独立计数');
  assert.equal((await on.login('guess8', 'wrong', { 'x-forwarded-for': '1.2.3.0' })).status, 429,
    '同一真实 IP 第 4 次失败仍被限速');
  // 用户名维度独立兜底：换个 IP 猜同一账号，失败累计到阈值后仍 429
  const userDim = await harness(t, { trustProxy: true, throttleOptions: { maxFailures: 3, maxFailuresIp: 100 } });
  for (let i = 0; i < 3; i++) {
    assert.equal((await userDim.login('bob', 'wrong', { 'x-forwarded-for': `10.0.0.${i}` })).status, 401);
  }
  assert.equal((await userDim.login('bob', 'wrong', { 'x-forwarded-for': '8.8.8.8' })).status, 429);
});

test('配置严格校验：非法 LOGIN_* 与 TRUST_PROXY 直接启动失败', () => {
  const load = (env) => spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./src/config').config))"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, ...env }, encoding: 'utf8'
  });
  const ok = load({});
  assert.equal(ok.status, 0);
  const defaults = JSON.parse(ok.stdout);
  assert.equal(defaults.trustProxy, false, 'TRUST_PROXY 默认关闭');
  assert.deepEqual(defaults.login, { maxFailures: 5, maxFailuresIp: 20, windowMs: 15 * 60 * 1000, maxEntries: 5000 });

  for (const env of [
    { LOGIN_MAX_FAILURES: '0' },
    { LOGIN_MAX_FAILURES: 'abc' },
    { LOGIN_WINDOW_MS: '1.5' },
    { LOGIN_MAX_FAILURES_IP: '-1' },
    { TRUST_PROXY: 'yes' }
  ]) {
    const bad = load(env);
    assert.notEqual(bad.status, 0, `应拒绝配置 ${JSON.stringify(env)}`);
    assert.match(bad.stderr, /非法配置|只接受/, `错误信息应指出非法配置 ${JSON.stringify(env)}`);
  }

  const custom = load({ LOGIN_MAX_FAILURES: '7', LOGIN_WINDOW_MS: '60000', TRUST_PROXY: '1' });
  assert.equal(custom.status, 0);
  const cfg = JSON.parse(custom.stdout);
  assert.equal(cfg.login.maxFailures, 7);
  assert.equal(cfg.login.windowMs, 60000);
  assert.equal(cfg.trustProxy, true);
});
