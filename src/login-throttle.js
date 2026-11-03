/**
 * 登录失败限速（进程内，无第三方依赖）。
 *
 * 只统计失败：成功登录清零；被限速的请求本身不再累加，否则持续爆破会让窗口永远不过期。
 * 同时按 IP 与用户名两个维度计数：
 *   - 用户名维度挡住「换 IP 爆破同一账号」；
 *   - IP 维度阈值默认更宽松（20 次），挡住「同一来源广撒网猜用户名」，
 *     同时避免 NAT 后一个人输错几次就把整栋楼拖死。
 * 任一维度达阈值即 429。Map 均有条数上限并做过期清理，不会无限增长。
 */

const LIMITS = { maxFailures: 5, maxFailuresIp: 20, windowMs: 15 * 60 * 1000, maxEntries: 5000 };

class LoginThrottle {
  constructor(options = {}) {
    const pick = (name, min, max) => {
      const v = options[name] === undefined ? LIMITS[name] : options[name];
      if (!Number.isInteger(v) || v < min || v > max) throw new Error(`非法限速配置 ${name}`);
      return v;
    };
    this.maxFailures = pick('maxFailures', 1, 1000);
    this.maxFailuresIp = pick('maxFailuresIp', 1, 100000);
    this.windowMs = pick('windowMs', 1000, 24 * 3600 * 1000);
    this.maxEntries = pick('maxEntries', 1, 100000);
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.byUser = new Map();
    this.byIp = new Map();
  }

  /** 取仍有效的桶；窗口过期视为清零但保持桶本身，便于继续累计。 */
  _bucket(map, key) {
    const now = this.now();
    let bucket = map.get(key);
    if (!bucket || now - bucket.firstAt >= this.windowMs) {
      bucket = { count: 0, firstAt: now };
      map.delete(key);
      map.set(key, bucket);
      if (map.size > this.maxEntries) this._prune(map);
    }
    return bucket;
  }

  /** 达到上限时先清过期项，仍超限就丢最早写入的（Map 迭代顺序即插入顺序）。 */
  _prune(map) {
    const now = this.now();
    for (const [key, bucket] of map) {
      if (now - bucket.firstAt >= this.windowMs) map.delete(key);
      if (map.size <= this.maxEntries) return;
    }
    while (map.size > this.maxEntries) map.delete(map.keys().next().value);
  }

  /** 返回 { allowed, retryAfterSec }；不修改计数。窗口已过的桶视为不存在。 */
  check(ip, username) {
    const now = this.now();
    const live = (map, key) => {
      const bucket = map.get(key);
      if (!bucket) return null;
      if (now - bucket.firstAt >= this.windowMs) { map.delete(key); return null; }
      return bucket;
    };
    const user = live(this.byUser, normalizeUser(username));
    const addr = live(this.byIp, String(ip || ''));
    const blocked = [];
    if (user && user.count >= this.maxFailures) blocked.push(user);
    if (addr && addr.count >= this.maxFailuresIp) blocked.push(addr);
    if (!blocked.length) return { allowed: true, retryAfterSec: 0 };
    // 以最晚恢复的那个桶为准，避免按错维度提前放行。
    const remaining = Math.max(...blocked.map((b) => b.firstAt + this.windowMs - now));
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(remaining / 1000)) };
  }

  fail(ip, username) {
    this._bucket(this.byUser, normalizeUser(username)).count += 1;
    this._bucket(this.byIp, String(ip || '')).count += 1;
  }

  /**
   * 成功登录只清用户名维度：若连 IP 维度一起清，
   * 攻击者只要持有一个合法账号就能反复重置 IP 计数去爆破别人。
   * IP 计数靠窗口自然过期，阈值也放宽，不会因为一次成功就误伤同 NAT 的其他人。
   */
  succeed(ip, username) {
    this.byUser.delete(normalizeUser(username));
  }

  /** 仅用于测试与运维观测：当前两个维度的桶数量。 */
  size() {
    return { users: this.byUser.size, ips: this.byIp.size };
  }
}

/** 用户名大小写不敏感（与 getUserByUsername 一致），限长避免恶意超长 key。 */
function normalizeUser(username) {
  return String(username || '').trim().toLowerCase().slice(0, 100);
}

module.exports = { LoginThrottle, normalizeUser, LIMITS };
