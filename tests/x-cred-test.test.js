/* X 账号测试（verify_credentials）：stub fetch 断言请求构造与四类结果。
 * 不真实联网；凭据一律假值，且断言结果对象绝不回显凭据。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { testXCredentials } = require('../src/importers');

const FAKE_AUTH = 'fake-auth-token-0123456789abcdef';
const FAKE_CT0 = 'fake-csrf-0123456789abcdef0123456789abcdef';
const BEARER_PREFIX = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs';

/** 同时替换全局 fetch 与 undici.fetch（makeFetch 视代理配置走其中之一），跑完必还原。 */
async function withFakeFetch(fakeFetch, fn) {
  const origFetch = global.fetch;
  const undici = require('undici');
  const origUfetch = undici.fetch;
  global.fetch = fakeFetch;
  undici.fetch = fakeFetch;
  try {
    return await fn();
  } finally {
    global.fetch = origFetch;
    undici.fetch = origUfetch;
  }
}

const jsonResponse = (status, obj) => ({ ok: status >= 200 && status < 300, status, json: async () => obj });
const CREDS = { authToken: FAKE_AUTH, ct0: FAKE_CT0, proxy: '', timeout: 15000 };
const INVALID_REASON = '凭据失效或不匹配（auth_token/ct0 已过期，或触发风控，请重新获取）';

test('成功：200 + screen_name → {ok:true,handle,name}，Bearer/csrf/cookie 三头齐全', async () => {
  const seen = [];
  const fakeFetch = async (url, opts = {}) => {
    seen.push({ url: String(url), headers: opts.headers || {}, signal: opts.signal });
    return jsonResponse(200, { screen_name: 'kururu', name: '966' });
  };
  const r = await withFakeFetch(fakeFetch, () => testXCredentials(CREDS));

  assert.deepEqual(r, { ok: true, handle: '@kururu', name: '966' });
  assert.equal(seen.length, 1, '只应发一次请求');
  const req = seen[0];
  assert.match(req.url, /^https:\/\/x\.com\/i\/api\/1\.1\/account\/verify_credentials\.json/);
  assert.ok(req.url.includes('skip_status=true'), 'URL 需带 skip_status=true');
  assert.ok(req.headers.authorization.startsWith(BEARER_PREFIX), '必须使用固定公开 Bearer');
  assert.equal(req.headers['x-csrf-token'], FAKE_CT0);
  assert.equal(req.headers.cookie, `auth_token=${FAKE_AUTH}; ct0=${FAKE_CT0}`);
  assert.ok(req.signal instanceof AbortSignal, '必须带超时 signal');
  // 结果对象不得携带凭据
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes(FAKE_AUTH) && !dump.includes(FAKE_CT0), '不得回显凭据');
});

test('401：凭据失效或不匹配文案', async () => {
  const r = await withFakeFetch(async () => jsonResponse(401, {}), () => testXCredentials(CREDS));
  assert.deepEqual(r, { ok: false, reason: INVALID_REASON });
});

test('403：凭据失效或不匹配文案', async () => {
  const r = await withFakeFetch(async () => jsonResponse(403, {}), () => testXCredentials(CREDS));
  assert.deepEqual(r, { ok: false, reason: INVALID_REASON });
});

test('200 但 errors code 32/353：按凭据失效处理', async () => {
  for (const code of [32, 353]) {
    const r = await withFakeFetch(
      async () => jsonResponse(200, { errors: [{ code, message: 'Could not authenticate you.' }] }),
      () => testXCredentials(CREDS)
    );
    assert.deepEqual(r, { ok: false, reason: INVALID_REASON }, `code ${code}`);
  }
});

test('429：频控文案', async () => {
  const r = await withFakeFetch(async () => jsonResponse(429, {}), () => testXCredentials(CREDS));
  assert.deepEqual(r, { ok: false, reason: '触发 X 频控，请稍后再试' });
});

test('网络错误/超时：连接失败（检查代理）文案', async () => {
  const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const r = await withFakeFetch(async () => { throw timeoutErr; }, () => testXCredentials(CREDS));
  assert.deepEqual(r, { ok: false, reason: '连接 X 失败（请检查代理设置）' });

  const r2 = await withFakeFetch(async () => { throw new Error('ECONNREFUSED'); }, () => testXCredentials(CREDS));
  assert.deepEqual(r2, { ok: false, reason: '连接 X 失败（请检查代理设置）' });
});

test('未配置凭据：不发任何网络请求，直接要求先保存', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return jsonResponse(200, { screen_name: 'x', name: 'x' }); };
  const r = await withFakeFetch(fakeFetch, async () => {
    const a = await testXCredentials({ authToken: '', ct0: FAKE_CT0, proxy: '', timeout: 15000 });
    const b = await testXCredentials({ authToken: FAKE_AUTH, ct0: '', proxy: '', timeout: 15000 });
    const c = await testXCredentials({});
    return [a, b, c];
  });
  for (const item of r) assert.deepEqual(item, { ok: false, reason: '请先填写并保存 auth_token 和 ct0' });
  assert.equal(calls, 0, '缺凭据不得发请求');
});

test('其他 HTTP 状态：异常状态文案；代理配置走 undici.fetch', async () => {
  const r = await withFakeFetch(async () => jsonResponse(500, {}), () => testXCredentials(CREDS));
  assert.equal(r.ok, false);
  assert.match(r.reason, /HTTP 500/);

  const seen = [];
  const r2 = await withFakeFetch(async (url) => { seen.push(String(url)); return jsonResponse(200, { screen_name: 'kururu', name: '966' }); },
    () => testXCredentials({ ...CREDS, proxy: 'http://127.0.0.1:9' }));
  assert.equal(r2.ok, true);
  assert.equal(seen.length, 1, '配置代理时也应发出（走 undici ProxyAgent 分支）');
});

test('200 但无 screen_name：不误报成功', async () => {
  const r = await withFakeFetch(async () => jsonResponse(200, {}), () => testXCredentials(CREDS));
  assert.equal(r.ok, false);
  assert.match(r.reason, /未返回账号信息/);
});

/* ---------------- 端点契约：POST /api/settings/x-test（真实 Express + 注入实现） ---------------- */
const express = require('express');
const createRoutes = require('../src/routes');

async function endpointHarness({ role = 'admin', result, settings = { twitterAuth: FAKE_AUTH, twitterCt0: FAKE_CT0, importProxy: 'http://proxy.local:8080' } } = {}) {
  const calls = [];
  const logs = [];
  const store = {
    getSession: (t) => (t === 'tok' ? { user: { id: 'u1', username: 'admin', role } } : null),
    getSettings: () => settings,
    addLog: async (level, msg) => { logs.push({ level, msg }); }
  };
  const app = express();
  app.use('/api', createRoutes({
    store, storage: {},
    testXCredentials: async (args) => { calls.push(args); return typeof result === 'function' ? result(args) : result; }
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${server.address().port}/api/settings/x-test`;
  const call = async (sid) => {
    const res = await fetch(url, { method: 'POST', headers: sid ? { cookie: `sid=${sid}` } : {} });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: res.status, text, json };
  };
  return { call, calls, logs, close: () => new Promise((r) => server.close(r)) };
}

test('端点：管理员成功 → 用已保存凭据 + 15s 超时，响应只含 ok/handle/name', async () => {
  // 注入实现故意夹带凭据字段，端点必须白名单化剔除
  const h = await endpointHarness({
    result: { ok: true, handle: '@kururu', name: '966', authToken: FAKE_AUTH, ct0: FAKE_CT0, cookie: `auth_token=${FAKE_AUTH}` }
  });
  try {
    const r = await h.call('tok');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true, handle: '@kururu', name: '966' });
    assert.ok(!r.text.includes(FAKE_AUTH) && !r.text.includes(FAKE_CT0), '响应不得回显凭据');
    assert.deepEqual(h.calls[0], { authToken: FAKE_AUTH, ct0: FAKE_CT0, proxy: 'http://proxy.local:8080', timeout: 15000 });
  } finally { await h.close(); }
});

test('端点：失败原因原样回传（结构化），且凭据不进响应/日志', async () => {
  const h = await endpointHarness({ result: { ok: false, reason: INVALID_REASON, authToken: FAKE_AUTH } });
  try {
    const r = await h.call('tok');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: false, reason: INVALID_REASON });
    assert.ok(!r.text.includes(FAKE_AUTH), '失败响应不得回显凭据');
    const allLogs = h.logs.map((l) => l.msg).join('\n');
    assert.ok(!allLogs.includes(FAKE_AUTH) && !allLogs.includes(FAKE_CT0), '日志不得含凭据');
  } finally { await h.close(); }
});

test('端点：未登录 401 / 非管理员 403，均不触发上游测试', async () => {
  const h = await endpointHarness({ result: { ok: true, handle: '@x', name: 'x' } });
  try {
    assert.equal((await h.call(null)).status, 401);
    assert.equal((await h.call('nobody')).status, 401);
  } finally { await h.close(); }

  const h2 = await endpointHarness({ role: 'user', result: { ok: true, handle: '@x', name: 'x' } });
  try {
    assert.equal((await h2.call('tok')).status, 403);
    assert.equal(h2.calls.length, 0, '非管理员不得触发真实测试');
  } finally { await h2.close(); }
});
