'use strict';

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

/**
 * Cookie 巡检器：启动后延迟自检一次，之后按间隔持续巡检全部账号。
 * 结果写入 account.cookieStatus，供「账号管理」页展示；状态翻转时写运行日志。
 */
class CookieMonitor {
  constructor({ store, bili, config }) {
    this.store = store;
    this.bili = bili;
    this.cfg = config || {};
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
    const r = await checkAccountCookie(this.bili, acc);
    const prev = acc.cookieStatus || null;

    const patch = {
      cookieStatus: { ok: r.ok, code: r.code, message: r.message || '', checkedAt: r.checkedAt }
    };
    // 有效时顺带刷新昵称/头像/uid，保证展示信息不过期
    if (r.ok && r.profile) {
      if (r.profile.uname) patch.uname = r.profile.uname;
      if (r.profile.uid) patch.uid = r.profile.uid;
      if (r.profile.avatar) patch.avatar = r.profile.avatar;
    }
    await this.store.updateAccount(acc.id, patch);

    const who = acc.uname || acc.name || acc.id;
    if (!prev || prev.ok !== r.ok) {
      if (r.ok) {
        await this.store.addLog('success', `B站账号「${who}」Cookie 状态恢复正常`, { userId: acc.userId });
      } else {
        await this.store.addLog('error', `B站账号「${who}」Cookie 异常：${r.message}`, { userId: acc.userId });
      }
    }
    return r;
  }
}

module.exports = { CookieMonitor, checkAccountCookie, cookieErrorText, COOKIE_ERROR_TEXT };
