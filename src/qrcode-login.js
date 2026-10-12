const crypto = require('crypto');
const { genId } = require('./store');
const { validateBiliCredentials, PassportError, maskAccount } = require('./bilibili-passport');

const SESSION_TTL_MS = 180000;      // 本地会话上限，B站 86038 优先判过期
const RESULT_TTL_MS = 60000;        // 成功结果短期保留，供客户端重放（已脱敏）
const GENERATE_INTERVAL_MS = 10000; // 同用户生成最小间隔
const POLL_INTERVAL_MS = 2000;      // 同 loginId 上游最短间隔（single-flight）
const MAX_SESSIONS = 100;

/** 路由层错误：只带 status + 中文 message，不含任何凭据。 */
class QrLoginError extends Error { constructor(status, message) { super(message); this.status = status; } }

class QrLoginService {
  constructor({ store, passport, bili, lock, qrcode = require('qrcode'), clock = () => Date.now(), refresh }) {
    Object.assign(this, { store, passport, bili, lock, qrcode, clock, refresh });
    this.sessions = new Map();   // loginId -> 会话（含 qrcodeKey 等敏感中间态，不出服务端）
    this.generated = new Map();  // userId -> 上次生成时间
    this.generating = new Set(); // userId -> 生成中
    this.active = new Set();     // 在途 poll，close 时等待
    this.closed = false;
    this.timer = setInterval(() => this.cleanup(), 30000);
    if (this.timer.unref) this.timer.unref();
  }

  cleanup() {
    const now = this.clock();
    for (const [id, s] of this.sessions) if (now > s.expiresAt + 60000 && !s.flight) this.sessions.delete(id);
    for (const [id, at] of this.generated) if (now - at > 240000) this.generated.delete(id);
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.active]);
    this.sessions.clear();
  }

  /** 生成二维码：只返回 {loginId, qrImage, expiresAt}，绝不外发 qrcode_key / 登录 URL。 */
  async generate({ userId, name = '', accountId }) {
    this.cleanup();
    const now = this.clock();
    if (this.closed) throw new QrLoginError(503, '登录服务已关闭');
    if (this.generating.has(userId)) throw new QrLoginError(429, '生成过于频繁，请稍后重试');
    if (this.generated.has(userId) && now - this.generated.get(userId) < GENERATE_INTERVAL_MS) throw new QrLoginError(429, '生成过于频繁，请稍后重试');
    if (this.sessions.size + this.generating.size >= MAX_SESSIONS) throw new QrLoginError(429, '登录会话繁忙，请稍后重试');
    this.generated.set(userId, now);
    this.generating.add(userId);
    try {
      const { url, qrcodeKey } = await this.passport.generateQr();
      const qrImage = await this.qrcode.toDataURL(url, { width: 256, margin: 4 });
      if (this.closed) throw new QrLoginError(503, '登录服务已关闭');
      // 每用户只保留 1 个活跃会话（已成功的短 TTL 结果保留供重放）
      for (const [id, s] of this.sessions) if (s.userId === userId && s.state !== 'success') this.sessions.delete(id);
      const loginId = crypto.randomBytes(24).toString('hex');
      const expiresAt = this.clock() + SESSION_TTL_MS;
      this.sessions.set(loginId, { userId, qrcodeKey, name: String(name || ''), accountId: accountId || '', expiresAt, state: 'waiting', cookies: {}, lastPoll: -Infinity, flight: null, result: null });
      return { loginId, qrImage, expiresAt: new Date(expiresAt).toISOString() };
    } finally {
      this.generating.delete(userId);
    }
  }

  /** 轮询：四态 {waiting|scanned|expired|success} + code + 脱敏 account。 */
  async poll({ userId, loginId }) {
    const s = this.sessions.get(loginId);
    if (!s || s.userId !== userId) throw new QrLoginError(404, '登录会话不存在或已失效');
    if (s.result) return s.result;                        // 幂等重放（已脱敏）
    if (s.state === 'expired' || this.clock() >= s.expiresAt) return this.expire(s);
    if (s.flight) return s.flight;                        // single-flight
    if (this.clock() - s.lastPoll < POLL_INTERVAL_MS) return { status: s.state, code: s.state === 'scanned' ? 86090 : 86101 };
    s.lastPoll = this.clock();
    s.flight = this.pollOne(s);
    this.active.add(s.flight);
    try { return await s.flight; } finally { this.active.delete(s.flight); s.flight = null; }
  }

  expire(s) {
    s.state = 'expired';
    s.qrcodeKey = ''; s.cookies = {}; // 已失效的二维码不再是凭证
    return { status: 'expired', code: 86038 };
  }

  async pollOne(s) {
    const result = await this.passport.pollQr(s.qrcodeKey, s.cookies);
    if (result.code !== 0) {
      s.state = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }[result.code] || 'waiting';
      if (s.state === 'expired') { s.qrcodeKey = ''; s.cookies = {}; }
      return { status: s.state, code: result.code };
    }
    const credentials = result.credentials;
    if (!credentials || !credentials.refreshToken) throw new PassportError('poll', 'protocol'); // 缺凭据：绝不半落库
    const profile = await validateBiliCredentials(this.bili, credentials); // 身份必须与 nav 一致
    // 同一用户的扫码提交串行，避免两个 loginId 并发新建同 mid。
    return this.lock.runExclusive(`qr-user:${s.userId}`, async () => {
      const candidates = this.store.listAccounts().filter(a => a.userId === s.userId && String(a.mid || a.uid) === profile.mid);
      let account;
      if (s.accountId) {
        account = this.store.getAccount(s.accountId);
        if (!account || account.userId !== s.userId) throw new QrLoginError(404, '账号不存在');
        if (String(account.mid || account.uid) !== profile.mid) throw new QrLoginError(409, '扫码账号与当前账号不一致，请使用对应账号扫码');
      } else {
        if (candidates.length > 1) throw new QrLoginError(409, '存在多个相同B站账号，请在对应账号卡点击「扫码更新」');
        account = candidates[0];
      }
      const id = account ? account.id : genId('acc');
      const updatedExisting = Boolean(account);
      return this.lock.runExclusive(id, async () => {
        if (updatedExisting) {
          const current = this.store.getAccount(id);
          if (!current || String(current.mid || current.uid) !== profile.mid) throw new QrLoginError(409, '目标账号已改变，请重新生成二维码');
        }
        const patch = {
          ...credentials, ...profile,
          lastCookieRefreshAt: undefined, // 新登录链：重置每日门禁
          cookieStatus: { ok: true, code: 0, message: '', checkedAt: new Date(this.clock()).toISOString() }
        };
        if (s.name.trim()) patch.name = s.name.trim();
        if (updatedExisting) await this.store.updateAccount(id, patch);
        else await this.store.addAccount({ ...patch, id, userId: s.userId, uid: profile.uid, name: patch.name || profile.uname || '未命名账号', createdAt: new Date(this.clock()).toISOString() });
        await this.store.flushNow();
        if (this.refresh) await this.refresh.clearPending(id);
        await this.store.addLog('info', `账号 ${id}：${updatedExisting ? '扫码原地更新登录态' : '扫码新增账号'}`, { userId: s.userId });
        const saved = this.store.getAccount(id);
        s.state = 'success';
        s.qrcodeKey = ''; s.cookies = {}; // 成功后不再保留任何登录链中间态
        s.expiresAt = this.clock() + RESULT_TTL_MS;
        s.result = { status: 'success', code: 0, account: maskAccount(saved), updatedExisting };
        return s.result;
      });
    });
  }
}

module.exports = { QrLoginService, QrLoginError, SESSION_TTL_MS, RESULT_TTL_MS, GENERATE_INTERVAL_MS, POLL_INTERVAL_MS };
