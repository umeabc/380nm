/* 测试：账号页扫码弹层状态机（离线驱动）+ 账号卡状态优先级 + 页面静态约束 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

function loadPage() {
  const sandbox = { setTimeout, clearTimeout, AbortController };
  sandbox.window = sandbox;
  sandbox.App = {
    $: () => null, icon: () => '<svg></svg>', esc: (s) => String(s == null ? '' : s),
    api: async () => ({ accounts: [] }), toast: () => {}, fmtTime: (s) => String(s),
    boot: () => Promise.resolve()
  };
  vm.runInNewContext(read('public/js/pages/accounts.js'), sandbox, { filename: 'accounts.js' });
  assert.ok(sandbox.AccountsQr, '页面必须暴露可离线驱动的 QR 控制器');
  return sandbox.AccountsQr;
}

const QR = loadPage();

/** 可完全离线驱动的控制器：假 timer + 假 request，无 DOM、无网络、无凭据 */
function drive() {
  let clock = 1000000;
  let seq = 0;
  const timers = new Map();
  const requests = [];
  const states = [];
  const queue = [];
  const controller = QR.createQrController({
    request: (method, url, body, signal) => {
      const entry = { method, url, body, aborted: false, signal };
      signal.addEventListener('abort', () => { entry.aborted = true; });
      requests.push(entry);
      const next = queue.shift();
      if (typeof next === 'function') return next(entry);
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
    now: () => clock,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
    onState: (s) => states.push(s),
    intervalMs: 2000,
    autoCloseMs: 520
  });
  return {
    controller, states, requests, queue, timers,
    push: (...items) => queue.push(...items),
    run: async () => {
      const first = [...timers.entries()][0];
      assert.ok(first, '应有待执行的轮询定时器');
      timers.delete(first[0]);
      await first[1].fn();
    },
    timerCount: () => timers.size,
    advance: (ms) => { clock += ms; },
    last: () => states[states.length - 1]
  };
}

const success = (extra = {}) => ({ status: 'success', code: 0, account: { id: 'acc_1', uname: '昵称', canAutoRefresh: true }, updatedExisting: false, ...extra });

test('扫描四态：生成→等待→已扫码→成功，串行轮询且成功即停', async () => {
  const d = drive();
  d.push({ loginId: 'L1', qrImage: 'data:image/png;base64,AA', expiresAt: new Date(1000000 + 180000).toISOString() });
  await d.controller.generate({ name: '主号' });
  assert.equal(d.requests[0].method, 'POST');
  assert.equal(d.requests[0].url, '/api/accounts/qrcode');
  assert.equal(d.requests[0].body.name, '主号');
  assert.equal(d.requests[0].body.accountId, undefined);
  assert.equal(JSON.stringify(d.requests[0].body), '{"name":"主号"}', '通用扫码不得提交额外字段');
  assert.equal(d.last().name, 'waiting');
  assert.equal(d.last().qrImage, 'data:image/png;base64,AA');
  assert.equal(d.timerCount(), 1, '一次只有一个待执行轮询');

  d.advance(2100); d.push({ status: 'waiting', code: 86101 });
  await d.run();
  assert.equal(d.last().name, 'waiting');
  assert.equal(d.requests[1].url, '/api/accounts/qrcode/L1/poll');
  assert.equal(d.timerCount(), 1);

  d.advance(2100); d.push({ status: 'scanned', code: 86090 });
  await d.run();
  assert.equal(d.last().name, 'scanned');
  assert.equal(d.timerCount(), 1);

  d.advance(2100); d.push(success({ updatedExisting: true }));
  await d.run();
  assert.equal(d.last().name, 'success');
  assert.equal(d.last().updatedExisting, true);
  assert.equal(d.timerCount(), 1, '成功后只剩自动关闭定时器');
  await d.run();
  assert.equal(d.last().name, 'closed');
  assert.equal(d.requests.length, 4, '成功之后不再轮询');
});

test('过期：B站86038 与本地期限都转终态，迟到等待响应不得恢复二维码', async () => {
  const d = drive();
  d.push({ loginId: 'L1', qrImage: 'data:image/png;base64,AA', expiresAt: new Date(1000000 + 180000).toISOString() });
  await d.controller.generate({ name: '' });
  d.advance(2100); d.push({ status: 'expired', code: 86038 });
  await d.run();
  assert.equal(d.last().name, 'expired');
  assert.equal(d.timerCount(), 0, '过期必须停止轮询');

  // 本地期限先到时，不再打上游，直接过期
  const e = drive();
  e.push({ loginId: 'L2', qrImage: 'data:image/png;base64,BB', expiresAt: new Date(1000000 + 3000).toISOString() });
  await e.controller.generate({ name: '' });
  e.advance(4000);
  await e.run();
  assert.equal(e.last().name, 'expired');
  assert.equal(e.requests.length, 1, '本地过期不得再请求上游');
  assert.equal(e.timerCount(), 0);

  // 过期代失效后迟到的 waiting 不上屏
  const before = e.states.length;
  e.push({ status: 'waiting', code: 86101 });
  assert.equal(e.states.length, before);
});

test('网络失败/404/429：停止等待只允许手动恢复，重试仍用同一 loginId', async () => {
  const d = drive();
  d.push({ loginId: 'L1', qrImage: 'data:image/png;base64,AA', expiresAt: new Date(1000000 + 180000).toISOString() });
  await d.controller.generate({ name: '' });
  d.advance(2100); d.push(Object.assign(new Error('offline'), { status: 0 }));
  await d.run();
  assert.equal(d.last().name, 'error');
  assert.equal(d.last().action, 'retry');
  assert.equal(d.timerCount(), 0, '网络错误必须停止后台自愈');

  d.advance(2100); d.push({ status: 'scanned', code: 86090 });
  d.controller.retry();
  assert.equal(d.timerCount(), 1);
  await d.run();
  assert.equal(d.requests[d.requests.length - 1].url, '/api/accounts/qrcode/L1/poll', '重试检查同一会话而不是新生成');
  assert.equal(d.last().name, 'scanned');

  d.advance(2100); d.push(Object.assign(new Error('gone'), { status: 404 }));
  await d.run();
  assert.equal(d.last().action, 'regenerate');
  assert.equal(d.timerCount(), 0);

  const e = drive();
  e.push(Object.assign(new Error('slow down'), { status: 429 }));
  await e.controller.generate({ name: '' });
  assert.equal(e.last().name, 'error');
  assert.equal(e.last().detail, '生成过于频繁，请稍后重试');
  assert.equal(e.timerCount(), 0, '限流必须停下等待用户手动操作');
});

test('关闭/在途请求：真实取消、迟到成功不动作、重复生成只保留一个会话', async () => {
  const d = drive();
  let release;
  const gate = new Promise((r) => { release = r; });
  d.push({ loginId: 'L1', qrImage: 'data:image/png;base64,AA', expiresAt: new Date(1000000 + 180000).toISOString() });
  await d.controller.generate({ name: '' });
  d.advance(2100);
  d.push((entry) => new Promise((resolve, reject) => {
    entry.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    gate.then(() => resolve(success()));
  }));
  const pending = d.run();
  assert.equal(d.controller.isActive(), true);

  d.controller.close();
  assert.equal(d.last().name, 'closed');
  assert.equal(d.requests[d.requests.length - 1].aborted, true, '关闭必须真实中止在途请求');
  release();
  await pending;
  assert.equal(d.states.filter((s) => s.name === 'success').length, 0, '关闭后的迟到成功不得重开弹层或落库提示');
  assert.equal(d.timerCount(), 0);

  // 关闭后早到的轮询结果也不得恢复
  const before = d.states.length;
  d.push({ status: 'waiting', code: 86101 });
  assert.equal(d.states.length, before);
});

test('账号卡状态优先级：nav异常 > 续期异常 > 待检测 > 无自动续期 > 正常', () => {
  const plain = (o) => JSON.parse(JSON.stringify(o));
  assert.deepEqual(plain(QR.badgeOf({ cookieStatus: undefined })), { cls: 'ck-unknown', text: '待检测', title: '尚未检测，稍后会自动巡检' });
  assert.equal(QR.badgeOf({ cookieStatus: { ok: true }, canAutoRefresh: true }).cls, 'ck-ok');
  assert.equal(QR.badgeOf({ cookieStatus: { ok: true }, canAutoRefresh: false }).cls, 'qrcode-no-refresh');
  assert.equal(QR.badgeOf({ cookieStatus: { ok: true }, canAutoRefresh: false }).text, '无自动续期');
  // Cookie 有效但续期异常：红显且不被 nav 成功刷绿
  const refreshErr = { ok: false, code: 0, message: 'Cookie有效，但自动续期失败：续期检查网络失败，将在下次检查时再试', refreshError: { code: 'info', message: '续期检查网络失败，将在下次检查时再试' } };
  assert.equal(QR.badgeOf({ cookieStatus: refreshErr, canAutoRefresh: true }).cls, 'ck-bad');
  assert.equal(QR.badgeOf({ cookieStatus: refreshErr, canAutoRefresh: true }).text, '续期异常');
  assert.deepEqual(plain(QR.statusLines({ cookieStatus: refreshErr })), [refreshErr.message]);
  // nav 异常：红显安全原因，另有续期原因时补一行
  const navBad = { ok: false, code: -101, message: 'Cookie已失效，请扫码更新', refreshError: { code: 'info', message: '续期检查网络失败' } };
  assert.equal(QR.badgeOf({ cookieStatus: navBad, canAutoRefresh: false }).text, '异常');
  assert.deepEqual(plain(QR.statusLines({ cookieStatus: navBad })), ['Cookie已失效，请扫码更新', '自动续期失败：续期检查网络失败']);
  // 86095 清 token 后仍维持红色续期异常 + 无能力弱提示
  const rescan = { ok: false, code: 86095, message: '续期链不匹配或失效，请重新扫码' };
  assert.equal(QR.badgeOf({ cookieStatus: rescan, canAutoRefresh: false }).cls, 'ck-bad');
  assert.deepEqual(plain(QR.statusLines({ cookieStatus: rescan })), ['续期链不匹配或失效，请重新扫码']);
  assert.deepEqual(plain(QR.statusLines({ cookieStatus: { ok: true } })), []);
});

test('页面静态约束：无 localStorage/无轮询叠加/无第三方/无原始登录URL/版本22/common零改动', () => {
  const page = read('public/js/pages/accounts.js');
  assert.doesNotMatch(page, /localStorage|sessionStorage/, 'QR/token 绝不做浏览器持久化');
  assert.doesNotMatch(page, /setInterval/, '必须串行 setTimeout 轮询，不用 setInterval 叠加');
  assert.match(page, /AbortController/);
  assert.match(page, /pagehide/);
  assert.doesNotMatch(page, /passport\.bilibili\.com|qrcode_key|qrcodeKey/, '不得请求上游或展示原始登录 URL/qrcode_key');
  assert.doesNotMatch(page, /App\.api\s*=/, '不得改 common 的 API 契约');
  assert.match(page, /type="password"/);
  assert.match(page, /autocomplete="off"/);
  assert.match(page, /#ck-refresh-token'\)\.value = ''/, '打开弹窗必须清空 token 输入');
  assert.match(page, /tk\.value = ''/, '关闭弹窗必须清空 token 输入');
  assert.match(page, /关闭停止等待，已确认登录可能已保存。/);
  assert.match(page, /二维码仅用于本次登录，请勿截图或分享。/);
  // 过期/成功/终态错误才清图；poll 网络失败只暂停等待，保留未到期二维码供重试
  assert.match(page, /qrImageSrc && !wrap\.querySelector\('img'\)/, '重试后必须复用缓存的二维码图片');
  assert.match(page, /state\.name === 'error' && state\.action !== 'retry'/, '瞬时网络失败不得清掉未到期二维码');
  assert.doesNotMatch(page, /dangerouslySet|document\.write/);

  const html = read('public/accounts.html');
  assert.match(html, /id="btn-acc-qrcode"/);
  assert.match(html, /class="[^"]*qrcode-migration[^"]*"/);
  assert.equal((html.match(/qrcode-migration-path/g) || []).length, 3, '迁移折叠区必须有 3 条路径');
  assert.match(html, /每30分钟一次/);
  assert.match(html, /最多每24小时检查或尝试一次/);
  assert.doesNotMatch(html, /立即续期/);
  assert.match(html, /app\.css\?v=22/);
  assert.match(html, /accounts\.js\?v=22/);

  const css = read('public/css/app.css');
  for (const cls of ['.qrcode-mask', '.qrcode-image-wrap', '.qrcode-status.is-scanned', '.qrcode-status.is-error', '.ck-badge.qrcode-no-refresh', '.qrcode-migration']) {
    assert.ok(css.includes(cls), `缺少样式 ${cls}`);
  }
  assert.doesNotMatch(css, /\.qrcode-mask\{[^}]*z-index/, '不得提升全站层级');

  assert.doesNotMatch(read('public/js/common.js'), /qrcode/i, 'common.js 必须零 diff');
});
