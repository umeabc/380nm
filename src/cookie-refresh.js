const fsp = require('fs/promises');
const path = require('path');
const { buildCorrespondPath, PassportError, validateBiliCredentials } = require('./bilibili-passport');
const DAY = 24 * 60 * 60 * 1000;
const sameCredentials = (a, b) => ['sessdata', 'bili_jct', 'refreshToken'].every(k => a[k] === b[k]);
// 阶段中文名：只用于拼装受控安全文案，不回显上游正文/URL/header。
const STAGE_TEXT = {
  nav: 'Cookie校验', info: '续期检查', correspond: '续期协议请求', refresh: '续期请求',
  confirm: '续期确认', generate: '二维码生成', poll: '扫码状态检查', commit: '续期提交',
  cookie: 'B站Cookie解析', credentials: '凭据解析'
};
/**
 * 凭据错误 → 面向用户的安全文案。仅依据受控的 stage/kind/code，
 * 不含上游 message/URL/header/body/token；错误对象本身也不携带秘密。
 */
function passportFailureMessage(e) {
  const stage = e && e.stage, kind = e && e.kind, code = e && e.code;
  const label = STAGE_TEXT[stage] || 'B站请求';
  if (kind === 'storage') return '凭据存储错误，请检查磁盘后重新扫码';
  if (code === -101) return 'Cookie已失效，请扫码更新';
  if (code === -111) return 'bili_jct（csrf）校验失败，请重新获取';
  if (code === -509 || kind === 'restricted') return '访问受限或请求频繁，请稍后或扫码更新';
  if (stage === 'refresh' && code === 86095) return '续期链不匹配或失效，请重新扫码';
  if (kind === 'timeout') return `${label}超时，请稍后重试`;
  if (kind === 'network') return '网络异常，无法连接B站';
  if (kind === 'identity') return '登录身份与账号不一致，请重新扫码';
  if (kind === 'protocol') return `${label}返回结构异常，请稍后重试`;
  if (kind === 'business') return `B站返回错误（code ${code}）`;
  return '凭据校验失败，请稍后重试';
}
function refreshFailure(e, at) {
  const stage = e instanceof PassportError ? e.stage : 'storage';
  const kind = e instanceof PassportError ? e.kind : 'storage';
  const code = e instanceof PassportError ? e.code : undefined;
  // 续期语境下的文案优先，其余落回通用安全文案
  let message = passportFailureMessage(e);
  if (kind === 'storage') message = '续期凭据保存失败，请联系维护者或扫码更新';
  if (kind === 'timeout') message = '续期检查超时，将在下次检查时再试';
  if (kind === 'network') message = '续期检查网络失败，将在下次检查时再试';
  if (kind === 'protocol') message = '续期协议异常，请联系维护者';
  return { code: code ?? kind, message, at, needsRescan: stage === 'refresh' && code === 86095 };
}
/**
 * nav 校验结果与既有 refreshError 合并：Cookie 有效也不能把续期异常刷绿。
 * info.message 存在时优先使用（调用方已保证是脱敏文案）。
 */
function mergedNavStatus(account, info, checkedAt) {
  const error = account.cookieStatus?.refreshError;
  const keep = error ? { refreshError: error } : {};
  if (info.code !== 0) {
    const code = Number.isFinite(info.code) ? info.code : null;
    const message = info.message || (String(code) === '-101' ? 'Cookie已失效，请扫码更新' : 'Cookie校验失败');
    return { ok: false, code, message, checkedAt, ...keep };
  }
  return { ok: !error, code: 0, message: error ? `Cookie有效，但自动续期失败：${error.message}` : '', checkedAt, ...keep };
}
class CookieRefreshService {
  constructor({ store, passport, bili, lock, dataDir, enabled = true, clock = () => Date.now() }) {
    Object.assign(this, { store, passport, bili, lock, enabled, clock });
    this.file = path.join(dataDir, 'cookie-refresh-pending.json'); this.records = {}; this.queue = Promise.resolve(); this.active = new Set(); this.controllers = new Set(); this.closed = false;
    this.loaded = this.load();
  }
  async load() {
    try {
      const records = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      if (!records || Array.isArray(records) || typeof records !== 'object') throw new Error();
      for (const [id, r] of Object.entries(records)) if (!r || r.accountId !== id || typeof r.oldToken !== 'string' || !r.newCredentials?.refreshToken || !r.oldCredentials || !['prepared', 'confirmed', 'pending'].includes(r.stage)) throw new Error();
      this.records = records;
    } catch (e) { if (e.code !== 'ENOENT') this.loadError = true; }
  }
  writeRecords(change) {
    const work = this.queue.then(async () => {
      const next = structuredClone(this.records); change(next);
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      await fsp.writeFile(this.file + '.tmp', JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(this.file + '.tmp', this.file); this.records = next;
    }); this.queue = work.catch(() => {}); return work;
  }
  async clearPending(id) { await this.loaded; if (this.loadError) throw new Error('恢复文件存储错误'); await this.writeRecords(r => { delete r[id]; }); }
  async close() { this.closed = true; for (const c of this.controllers) c.abort(); await Promise.allSettled([...this.active]); await this.queue; }
  checkIfDue(id) {
    const work = this.check(id); this.active.add(work); work.finally(() => this.active.delete(work)).catch(() => {}); return work;
  }
  async check(id) {
    await this.loaded;
    if (!this.enabled || this.closed) return 'skipped';
    const attempt = await this.lock.tryExclusive(id, async () => {
      const a = this.store.getAccount(id);
      if (!a || (!a.refreshToken && !this.records[id])) return 'skipped';
      const now = this.clock();
      if (Number.isFinite(Date.parse(a.lastCookieRefreshAt)) && now - Date.parse(a.lastCookieRefreshAt) < DAY) return 'skipped';
      if (this.store.listJobs().some(j => j.accountId === id && j.status === 'publishing')) return 'skipped';
      const at = new Date(now).toISOString();
      const controller = new AbortController(); this.controllers.add(controller); const timer = setTimeout(() => controller.abort(), 75000);
      try {
        if (this.loadError) throw new Error('storage');
        // 最后每日检查/尝试的开始时间，失败也计次；先落盘再请求。
        await this.store.updateAccount(id, { lastCookieRefreshAt: at }); await this.store.flushNow();
        if (this.records[id]) return await this.resumeLocked(id, controller.signal);
        const credentials = { ...a };
        const info = await this.passport.cookieInfo(credentials, controller.signal);
        if (!info.refresh) return 'notNeeded';
        const refreshCsrf = await this.passport.getRefreshCsrf(credentials, buildCorrespondPath(info.timestamp), controller.signal);
        const next = await this.passport.refreshCookie(credentials, { refreshCsrf, refreshToken: credentials.refreshToken, signal: controller.signal });
        const record = { accountId: id, oldToken: credentials.refreshToken, oldCredentials: { sessdata: credentials.sessdata, bili_jct: credentials.bili_jct, refreshToken: credentials.refreshToken }, newCredentials: next, stage: 'prepared', createdAt: at };
        await this.writeRecords(r => { r[id] = record; });
        return await this.resumeLocked(id, controller.signal);
      } catch (e) { await this.fail(id, e, at); return 'failed'; }
      finally { clearTimeout(timer); this.controllers.delete(controller); }
    });
    return attempt.executed ? attempt.result : 'skipped';
  }
  async fail(id, e, at = new Date(this.clock()).toISOString()) {
    const a = this.store.getAccount(id); if (!a) return;
    const error = refreshFailure(e, at); const previous = a.cookieStatus?.refreshError;
    await this.store.updateAccount(id, { ...(error.needsRescan ? { refreshToken: undefined } : {}), cookieStatus: { ...(a.cookieStatus || {}), ok: false, message: error.message, refreshError: error } });
    try { await this.store.flushNow(); } catch { /* 原存储错误已红显，不能继续旋转。 */ }
    if (!previous || previous.code !== error.code || previous.message !== error.message) await this.store.addLog('warn', `账号 ${id}：${error.message}`, { userId: a.userId });
  }
  async resumePending(id) {
    const result = await this.checkIfDue(id);
    return result === 'refreshed' ? 'confirmed' : result === 'stale' ? 'stale' : 'pending';
  }
  async resumeLocked(id, signal) {
    const r = this.records[id], a = this.store.getAccount(id);
    if (!r || !a) return 'stale';
    if (!sameCredentials(a, r.oldCredentials) && !sameCredentials(a, r.newCredentials)) { await this.clearPending(id); return 'stale'; }
    let confirmError;
    if (r.stage !== 'confirmed') {
      try { await this.passport.confirmRefresh(r.newCredentials, r.oldToken, signal); await this.writeRecords(records => { records[id].stage = 'confirmed'; }); }
      catch (e) { confirmError = e; await this.writeRecords(records => { records[id].stage = 'pending'; }); }
    }
    const current = this.store.getAccount(id);
    if (!current || (!sameCredentials(current, r.oldCredentials) && !sameCredentials(current, r.newCredentials))) throw new PassportError('commit', 'identity');
    await this.store.updateAccount(id, { ...r.newCredentials, cookieStatus: { ok: !confirmError, code: 0, message: confirmError ? '新Cookie已取得，确认旧链失败' : '', checkedAt: new Date(this.clock()).toISOString(), ...(confirmError ? { refreshError: { code: 'pendingConfirm', message: '新Cookie已取得，确认旧链失败', at: new Date(this.clock()).toISOString(), needsRescan: false } } : {}) } });
    await this.store.flushNow();
    if (!confirmError) { await this.clearPending(id); await this.store.addLog('info', `账号 ${id} 自动续期/确认恢复成功`, { userId: a.userId }); }
    else await this.store.addLog('warn', `账号 ${id}：新Cookie已取得，确认旧链失败`, { userId: a.userId });
    try { const profile = await validateBiliCredentials(this.bili, r.newCredentials); await this.store.updateAccount(id, profile); } catch { /* 后续nav巡检显示状态。 */ }
    return confirmError ? 'pendingConfirm' : 'refreshed';
  }
}
module.exports = { CookieRefreshService, mergedNavStatus, sameCredentials, refreshFailure, passportFailureMessage, STAGE_TEXT, DAY };
