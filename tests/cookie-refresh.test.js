const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { Store } = require('../src/store');
const { AccountCredentialsLock } = require('../src/account-credentials-lock');
const { CookieRefreshService, DAY, mergedNavStatus, refreshFailure, passportFailureMessage } = require('../src/cookie-refresh');
const { PassportError } = require('../src/bilibili-passport');
const { CookieMonitor } = require('../src/cookie-monitor');
const { Scheduler } = require('../src/scheduler');
async function fixture(t, overrides = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '380nm-refresh-test-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'db.json'));
  const old = { id: 'a', userId: 'user', uid: 42, mid: '42', sessdata: 'fake-old', bili_jct: 'fake-csrf', refreshToken: 'fake-old-token' };
  await store.addAccount(old); await store.flushNow();
  let now = 1700000000000; const order = [];
  const next = { mid: '42', sessdata: 'fake-new', bili_jct: 'fake-new-csrf', refreshToken: 'fake-new-token' };
  const passport = {
    cookieInfo: async () => { const db = JSON.parse(await fsp.readFile(store.file, 'utf8')); assert.equal(db.accounts[0].lastCookieRefreshAt, new Date(now).toISOString()); order.push('info'); return { refresh: true, timestamp: now }; },
    getRefreshCsrf: async (c, hex) => { order.push('correspond'); assert.match(hex, /^[0-9a-f]{256}$/); return 'fake-html-csrf'; },
    refreshCookie: async (c, opts) => { order.push('refresh'); assert.equal(opts.refreshToken, 'fake-old-token'); return next; },
    confirmRefresh: async (c, token) => { order.push('confirm'); assert.equal(c.bili_jct, 'fake-new-csrf'); assert.equal(token, 'fake-old-token'); const recovery = JSON.parse(await fsp.readFile(path.join(dir, 'cookie-refresh-pending.json'), 'utf8')); assert.equal(recovery.a.stage, 'prepared'); }
  }; Object.assign(passport, overrides);
  const lock = new AccountCredentialsLock();
  const bili = { getMyInfo: async () => ({ code: 0, data: { mid: 42, uname: '虚构账号', face: '' } }) };
  const service = new CookieRefreshService({ store, passport, bili, lock, dataDir: dir, clock: () => now });
  t.after(async () => { await service.close(); await store.flushNow(); });
  return { service, store, passport, bili, lock, dir, next, order, advance: () => { now += DAY; }, clock: () => now };
}
test('五步顺序、新Cookie/token整组持久化及准备记录先于confirm', async t => {
  const f = await fixture(t); assert.equal(await f.service.checkIfDue('a'), 'refreshed'); assert.deepEqual(f.order, ['info', 'correspond', 'refresh', 'confirm']);
  const db = JSON.parse(await fsp.readFile(f.store.file, 'utf8')); assert.equal(db.accounts[0].refreshToken, 'fake-new-token'); assert.equal(db.accounts[0].sessdata, 'fake-new');
  assert.deepEqual(JSON.parse(await fsp.readFile(f.service.file, 'utf8')), {});
  assert.equal(await f.service.checkIfDue('a'), 'skipped');
});
test('info false不生成correspond且每日跨重启频控', async t => {
  const f = await fixture(t, { cookieInfo: async () => ({ refresh: false, timestamp: 1234 }) }); assert.equal(await f.service.checkIfDue('a'), 'notNeeded'); assert.deepEqual(f.order, []);
  const restart = new CookieRefreshService({ store: f.store, passport: f.passport, bili: f.bili, lock: f.lock, dataDir: f.dir, clock: f.clock }); assert.equal(await restart.checkIfDue('a'), 'skipped'); await restart.close();
});
test('publishing及独占锁跳过不消耗额度、不同账号独立、finally释放', async t => {
  const f = await fixture(t); f.store.data.jobs.push({ accountId: 'a', status: 'publishing' }); assert.equal(await f.service.checkIfDue('a'), 'skipped'); assert.equal(f.store.getAccount('a').lastCookieRefreshAt, undefined); f.store.data.jobs = [];
  await f.lock.runExclusive('a', async () => { assert.equal(await f.service.checkIfDue('a'), 'skipped'); assert.equal((await f.lock.tryExclusive('other', async () => 'other')).result, 'other'); });
  await assert.rejects(f.lock.runExclusive('a', async () => { throw new Error(); })); assert.equal((await f.lock.tryExclusive('a', async () => true)).executed, true);
});
test('refresh86095清旧token，-101/超时/风控保留，失败计次且nav不刷绿', async t => {
  for (const e of [new PassportError('refresh', 'business', 86095), new PassportError('info', 'business', -101), new PassportError('info', 'timeout'), new PassportError('info', 'restricted', undefined, 412)]) {
    const f = await fixture(t, { cookieInfo: async () => { if (e.stage === 'info') throw e; return { refresh: true, timestamp: 1234 }; }, refreshCookie: async () => { throw e; } });
    assert.equal(await f.service.checkIfDue('a'), 'failed'); const a = f.store.getAccount('a'); assert.equal(Boolean(a.refreshToken), e.code !== 86095); assert.equal(a.cookieStatus.ok, false); assert.equal(mergedNavStatus(a, { code: 0 }, 'now').ok, false); assert.equal(await f.service.checkIfDue('a'), 'skipped');
  }
});
test('confirm丢响应保留新链、恢复次日只confirm不旋转、confirm86095不清新token', async t => {
  const f = await fixture(t, { confirmRefresh: async () => { throw new PassportError('confirm', 'business', 86095); } });
  assert.equal(await f.service.checkIfDue('a'), 'pendingConfirm'); assert.equal(f.store.getAccount('a').refreshToken, 'fake-new-token'); assert.equal(f.service.records.a.oldToken, 'fake-old-token');
  assert.equal(await f.service.checkIfDue('a'), 'skipped'); f.advance(); f.passport.confirmRefresh = async () => { f.order.push('resume-confirm'); };
  assert.equal(await f.service.checkIfDue('a'), 'refreshed'); assert.deepEqual(f.order, ['info', 'correspond', 'refresh', 'resume-confirm']);
});
test('已confirm但旧db崩溃恢复、新扫码链不被恢复覆盖、开关0保留恢复记录', async t => {
  const f = await fixture(t); const old = { ...f.store.getAccount('a') };
  await f.service.loaded; await f.service.writeRecords(r => { r.a = { accountId: 'a', oldToken: old.refreshToken, oldCredentials: old, newCredentials: f.next, stage: 'confirmed', createdAt: 'fake' }; });
  f.passport.confirmRefresh = async () => { assert.fail('已确认不重复confirm'); };
  f.service.enabled = false; assert.equal(await f.service.checkIfDue('a'), 'skipped'); assert.ok(f.service.records.a); f.service.enabled = true;
  assert.equal(await f.service.checkIfDue('a'), 'refreshed'); assert.equal(f.store.getAccount('a').refreshToken, f.next.refreshToken);
  f.advance(); await f.service.writeRecords(r => { r.a = { accountId: 'a', oldToken: old.refreshToken, oldCredentials: old, newCredentials: f.next, stage: 'prepared', createdAt: 'fake' }; });
  await f.store.updateAccount('a', { sessdata: 'fake-qr', bili_jct: 'fake-qr-csrf', refreshToken: 'fake-qr-token' });
  assert.equal(await f.service.checkIfDue('a'), 'stale'); assert.equal(f.store.getAccount('a').refreshToken, 'fake-qr-token');
});
test('准备记录落盘失败不confirm，提交落盘失败保留confirmed记录供恢复', async t => {
  const f = await fixture(t); const write = f.service.writeRecords.bind(f.service);
  f.service.writeRecords = async () => { throw new Error('fake disk fail'); };
  assert.equal(await f.service.checkIfDue('a'), 'failed'); assert.deepEqual(f.order, ['info', 'correspond', 'refresh']); assert.equal(f.store.getAccount('a').refreshToken, 'fake-old-token');
  f.service.writeRecords = write; f.advance(); const flush = f.store.flushNow.bind(f.store); let calls = 0;
  f.store.flushNow = async () => { if (++calls === 2) throw new Error('fake commit fail'); return flush(); };
  assert.equal(await f.service.checkIfDue('a'), 'failed'); assert.equal(f.service.records.a.stage, 'confirmed'); assert.equal(f.store.getAccount('a').refreshToken, 'fake-new-token');
  f.store.flushNow = flush; f.advance(); f.passport.confirmRefresh = async () => assert.fail('confirmed不得重复请求');
  assert.equal(await f.service.checkIfDue('a'), 'refreshed'); assert.equal(f.service.records.a, undefined);
});
test('关停真实中止在途请求并等待错误状态安全保存', async t => {
  const f = await fixture(t); let started; const ready = new Promise(r => { started = r; }); let aborted = false;
  f.passport.cookieInfo = (credentials, signal) => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => { aborted = true; reject(new PassportError('info', 'timeout')); }); });
  const work = f.service.checkIfDue('a'); await ready; await f.service.close(); assert.equal(await work, 'failed'); assert.equal(aborted, true); assert.equal(f.store.getAccount('a').refreshToken, 'fake-old-token');
  assert.equal(JSON.parse(await fsp.readFile(f.store.file, 'utf8')).accounts[0].cookieStatus.ok, false);
});
test('恢复文件损坏与每日时间落盘失败禁止网络、Store并发快照串行flush', async t => {
  const f = await fixture(t); f.service.loadError = true; assert.equal(await f.service.checkIfDue('a'), 'failed'); assert.deepEqual(f.order, []);
  f.service.loadError = false; f.advance(); const flush = f.store.flushNow.bind(f.store); f.store.flushNow = async () => { throw new Error('fake disk fail'); }; assert.equal(await f.service.checkIfDue('a'), 'failed'); assert.deepEqual(f.order, []); f.store.flushNow = flush;
  f.store.data.settings.marker = 1; const one = f.store.flushNow(); f.store.data.settings.marker = 2; const two = f.store.flushNow(); await Promise.all([one, two]); const db = JSON.parse(await fsp.readFile(f.store.file, 'utf8')); assert.equal(db.settings.marker, 2);
});
test('monitor先续期后nav、红显不被nav成功刷绿、旧快照结果丢弃', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '380nm-monitor-test-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'db.json'));
  const error = { code: 'info', message: '续期检查网络失败，将在下次检查时再试', at: 'x', needsRescan: false };
  await store.addAccount({ id: 'a', userId: 'u', mid: '42', uid: 42, sessdata: 'fake-sess', bili_jct: 'fake-csrf', refreshToken: 'fake-token', cookieStatus: { ok: false, code: 'info', message: error.message, refreshError: error } });
  await store.flushNow();
  const order = [];
  const lock = new AccountCredentialsLock();
  const refresh = { checkIfDue: async (id) => { order.push('refresh:' + id); return 'failed'; } };
  const bili = { getMyInfo: async () => { order.push('nav'); return { code: 0, data: { mid: 42, uname: '新昵称', face: 'https://face' } }; } };
  const monitor = new CookieMonitor({ store, bili, config: {}, refresh, lock });
  const r = await monitor.checkOne('a');
  assert.deepEqual(order, ['refresh:a', 'nav'], '必须续期在 nav 之前');
  assert.equal(r.cookieStatus.ok, false, 'nav 成功不得清除续期异常');
  assert.match(r.cookieStatus.message, /^Cookie有效，但自动续期失败：/);
  const a = store.getAccount('a');
  assert.equal(a.cookieStatus.refreshError.code, 'info');
  assert.equal(a.uname, '新昵称');
  assert.equal(a.mid, '42');

  // 等待锁期间凭据被换掉：旧 nav 结果必须丢弃，不能用旧快照改新链状态
  const before = JSON.stringify(store.getAccount('a').cookieStatus);
  const bili2 = { getMyInfo: async () => { await store.updateAccount('a', { sessdata: 'fake-new-sess' }); return { code: 0, data: { mid: 42, uname: '别人改的', face: '' } }; } };
  const monitor2 = new CookieMonitor({ store, bili: bili2, config: {}, refresh, lock });
  assert.equal(await monitor2.checkOne('a'), null);
  assert.equal(JSON.stringify(store.getAccount('a').cookieStatus), before, '不得覆盖新链状态');
  await store.flushNow();
});
test('scheduler账号锁：锁内读取新链、轮询期间续期跳过且不计失败次数', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), '380nm-sched-test-')); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'db.json'));
  await store.addAccount({ id: 'a', userId: 'u', mid: '42', uid: 42, sessdata: 'old-sess', bili_jct: 'old-csrf', refreshToken: 'fake-token' });
  await store.addJob({ id: 'j1', userId: 'u', accountId: 'a', status: 'pending', scheduledAt: new Date().toISOString(), text: '正文', type: '原创', slots: {}, images: [], attempts: 0 });
  await store.flushNow();
  const lock = new AccountCredentialsLock();
  const refresh = new CookieRefreshService({ store, passport: { cookieInfo: async () => { throw new PassportError('info', 'network'); } }, bili: {}, lock, dataDir: dir });
  t.after(async () => { await refresh.close(); await store.flushNow(); });

  const published = [];
  let duringLock = null;
  const bili = {
    uploadImage: async () => 'fake-pic',
    createDynamic: async (o) => { duringLock = await refresh.checkIfDue('a'); published.push(o.sessdata); return { dynamicId: 'd1', url: 'http://x' }; }
  };
  const scheduler = new Scheduler({ store, storage: { get: async () => ({ buffer: Buffer.from('x'), contentType: 'image/png' }) }, bili, config: { maxAttempts: 3, retryDelayMs: 1000, intervalMs: 1000 }, lock });

  // 续期先持锁：发布保持 pending 等待，不计失败、不改排期
  let release; const held = lock.runExclusive('a', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setTimeout(r, 5));
  const work = scheduler.processJob('j1');
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(store.getJob('j1').status, 'pending');
  assert.equal(store.getJob('j1').attempts, 0);
  await store.updateAccount('a', { sessdata: 'new-sess' }); // 续期写入新链后释放锁
  release(); await held; await work;
  assert.equal(store.getJob('j1').status, 'published');
  assert.deepEqual(published, ['new-sess'], '必须在锁内读取最新凭据，不用锁外的旧快照');
  assert.equal(duringLock, 'skipped', '发布持锁期间续期必须跳过（不消耗每日额度）');
  assert.equal(store.getJob('j1').attempts, 0, '锁等待不计尝试次数');
  assert.equal(store.getAccount('a').lastCookieRefreshAt, undefined, '发布期间跳过不消耗额度');
});
test('安全文案只依据受控 stage/kind/code，不含上游正文', () => {
  assert.equal(passportFailureMessage(new PassportError('nav', 'business', -101)), 'Cookie已失效，请扫码更新');
  assert.equal(passportFailureMessage(new PassportError('refresh', 'business', 86095)), '续期链不匹配或失效，请重新扫码');
  assert.equal(passportFailureMessage(new PassportError('nav', 'network')), '网络异常，无法连接B站');
  assert.equal(passportFailureMessage(new PassportError('nav', 'identity')), '登录身份与账号不一致，请重新扫码');
  assert.equal(refreshFailure(new PassportError('info', 'timeout'), 'x').message, '续期检查超时，将在下次检查时再试');
  assert.equal(refreshFailure(new PassportError('info', 'network'), 'x').message, '续期检查网络失败，将在下次检查时再试');
  assert.equal(refreshFailure(new Error('boom'), 'x').message, '续期凭据保存失败，请联系维护者或扫码更新');
  assert.equal(refreshFailure(new PassportError('refresh', 'business', 86095), 'x').needsRescan, true);
});
