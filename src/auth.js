const crypto = require('crypto');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const calc = crypto.scryptSync(String(password), salt, 64);
    const expect = Buffer.from(hash, 'hex');
    return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
  } catch (e) {
    return false;
  }
}

function newSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) {
      try {
        out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
      } catch (e) { /* 忽略非法编码 */ }
    }
  });
  return out;
}

/** 从会话 Cookie 解析当前用户并挂到 req.user */
function attachUser(store) {
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies.sid || null;
    req.sessionToken = token;
    req.user = null;
    if (token) {
      const sess = store.getSession(token);
      if (sess) req.user = sess.user;
    }
    next();
  };
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录或会话已过期' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '未登录或会话已过期' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

module.exports = {
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  newSessionToken,
  parseCookies,
  attachUser,
  requireAuth,
  requireAdmin
};
