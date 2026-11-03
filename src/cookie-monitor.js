'use strict';

const { mergedNavStatus } = require('./cookie-refresh');

/** B站接口错误码 → 面向用户的中文说明 */
const COOKIE_ERROR_TEXT = {
  '-101': 'Cookie 已失效（账号未登录），请点「修改 Cookie」重新填写',
  '-111': 'bili_jct（csrf）校验失败，请重新获取',
  '-400': '请求被拒绝，请稍后重试',
  '-403': '访问权限不足（可能触发风控），请稍后重试',
  '-509': '请求过于频繁，请稍后重试'
};

/** 由 getMyInfo 返回体生成可读的异常说明 */
function cookieErrorText(info) {
  const code = Number(info && info.code);
  const hit = COOKIE_ERROR_TEXT[String(code)];
  if (hit) return hit;
  const msg = (info && info.message) || '';
  return msg ? `Cookie 异常（code ${code}）：${msg}` : `Cookie 异常（code ${code}）`;
}

/**
 * 检测单个账号的 Cookie 是否有效。
 * 返回 { ok, code, message, checkedAt, profile? }
 */
async function checkAccountCookie(bili, account) {
  const checkedAt = new Date().toISOString();
  let info;
  try {
    info = await bili.getMyInfo(account.sessdata);
  } catch (e) {
    return { ok: false, checkedAt, code: null, message: '网络错误：' + e.message };
  }
  if (Number(info && info.code) === 0 && info.data) {
    return {
      ok: true,
      checkedAt,
      code: 0,
      message: '',
      profile: { uid: info.data.mid, uname: info.data.uname, avatar: info.data.face || '' }
    };
  }
  return {
    ok: false,
    checkedAt,
    code: Number(info && info.code) || null,
    message: cookieErrorText(info)
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 登录链字段快照：Store 返回活对象引用，比较必须落到原始值 */
const credentialSnapshot = (a) => [a.sessdata, a.bili_jct, a.refreshToken, a.mid || a.uid].join('\u0000');

/**
 * Cookie 巡检器：启动后延迟自检一次，之后按间隔持续巡检全部账号。
 * 结果写入 account.cookieStatus，供「账号管理」页展示；状态翻转时写运行日志。
 * 若注入 refresh（CookieRefreshService）：每个账号先做每日续期，再做 30 分钟 nav 校验，
 * 避免把本可续期恢复的 Cookie 先判死；nav 成功也不清除 refreshError（可能红显）。
 */
class CookieMonitor {
  constructor({ store, bili, config, refresh, lock }) {
    this.store = store;
    this.bili = bili;
    this.cfg = config || {};
    this.refresh = refresh || null;
    this.lock = lock || null;
    this._timer = null;
    this._boot = null;
    this._busy = false;
  }

  start() {
    const delay = Number(this.cfg.startupDelayMs) || 8000;
    const interval = Number(this.cfg.intervalMs) || 30 * 60 * 1000;
    this._boot = setTimeout(() => {
      this.checkAll().catch((e) => console.error('[cookie] 启动巡检失败:', e.message));
    }, delay);
    if (this._boot.unref) this._boot.unref();
    this._timer = setInterval(() => {
      this.checkAll().catch((e) => console.error('[cookie] 定时巡检失败:', e.message));
    }, interval);
    if (this._timer.unref) this._timer.unref();
    console.log(`  账号 Cookie 巡检: 每 ${Math.round(interval / 60000)} 分钟一次`);
  }

  stop() {
    if (this._boot) { clearTimeout(this._boot); this._boot = null; }
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /** 巡检全部账号（串行 + 间隔限速，避免触发B站风控） */
  async checkAll() {
    if (this._busy) return;
    this._busy = true;
    try {
      for (const acc of this.store.listAccounts()) {
        await this.checkOne(acc.id);
        await sleep(Number(this.cfg.gapMs) || 1500);
      }
    } finally {
      this._busy = false;
    }
  }

  /** 检测并落库单个账号的状态；仅在状态翻转时写日志，避免刷屏 */
  async checkOne(accountId) {
    const acc = this.store.getAccount(accountId);
    if (!acc) return null;
    // 1) 每日续期（自带账号独占锁与 24h 门禁；publishing 或锁占用时跳过且不消耗额度）
    if (this.refresh) {
      try { await this.refresh.checkIfDue(accountId); }
      catch (e) { console.error('[cookie] 续期检查异常:', e && e.message ? e.message : e); }
      if (!this.store.getAccount(accountId)) return null; // 续期期间账号可能被删除
    }
    // 2) 原 nav 校验；等锁以避开正在发布的账号，并用锁内快照防止旧结果覆盖新链
    const nav = () => this.navCheck(accountId);
    return this.lock ? this.lock.runExclusive(accountId, nav) : nav();
  }

  async navCheck(accountId) {
    const acc = this.store.getAccount(accountId);
    if (!acc) return null;
    // Store 返回的是活对象引用，必须用字段快照判断，不能只留引用
    const snapshot = credentialSnapshot(acc);
    const r = await checkAccountCookie(this.bili, acc);
    const current = this.store.getAccount(accountId);
    // 等待锁期间凭据可能已被续期/扫码/手动更换：丢弃过期结果，绝不用旧快照改新链状态
    if (!current || credentialSnapshot(current) !== snapshot) return null;
    const prev = current.cookieStatus || null;
    const merged = mergedNavStatus(current, {
      code: r.ok ? 0 : r.code,
      message: r.ok ? '' : r.message
    }, r.checkedAt);

    const patch = { cookieStatus: merged };
    // 有效时顺带刷新昵称/头像/uid/mid，保证展示信息不过期
    if (r.ok && r.profile) {
      if (r.profile.uname) patch.uname = r.profile.uname;
      if (r.profile.uid) { patch.uid = r.profile.uid; patch.mid = String(r.profile.uid); }
      if (r.profile.avatar) patch.avatar = r.profile.avatar;
    }
    await this.store.updateAccount(accountId, patch);

    const who = current.uname || current.name || accountId;
    if (!prev || prev.ok !== merged.ok) {
      if (merged.ok) {
        await this.store.addLog('success', `B站账号「${who}」Cookie 状态恢复正常`, { userId: current.userId });
      } else {
        await this.store.addLog('error', `B站账号「${who}」Cookie 异常：${merged.message}`, { userId: current.userId });
      }
    }
    return { ...r, cookieStatus: merged };
  }
}

module.exports = { CookieMonitor, checkAccountCookie, cookieErrorText, COOKIE_ERROR_TEXT };
