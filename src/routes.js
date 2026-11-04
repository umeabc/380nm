const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { genId, sanitizeUser } = require('./store');
const { renderTemplate, renderBody, extractVariableKeys } = require('./render');
const Staff = require('./staff');
const { templateColumns } = require('./template-columns');
const { TASK_TYPES, TYPE_SLOTS, SLOT_LABELS } = require('./templates');
const {
  hashPassword, verifyPassword, attachUser, requireAuth, requireAdmin
} = require('./auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 9 }
});

const { importFromUrl, parseWork, parseSource, testXCredentials, ImportError } = require('./importers');
const { buildZip, unzip } = require('./zip');
const { decodeMojibakeName } = require('./filename');
const {
  CSV_HEADERS, CSV_TYPE_SET, csvRow, sanitizeZipName, jobToCsvCells, buildQueueCsv, parseQueueCsv,
  resolveCsvTime, magicForImage, imageExtMatchesMagic, contentTypeForMagic
} = require('./queue-csv');
const { mergeLibraryMentions } = require('./mentions');

const { thumbnailConfig, validateKey } = require('./thumb-config');
const { createThumbnailService } = require('./thumbs');
const { findReadableImage } = require('./image-access');
const { LoginThrottle } = require('./login-throttle');
const { config } = require('./config');
const { AccountCredentialsLock } = require('./account-credentials-lock');
const { validateBiliCredentials, PassportError, maskSecret, maskAccount } = require('./bilibili-passport');
const { mergedNavStatus, passportFailureMessage } = require('./cookie-refresh');

const MAX_IMAGES = 9;
const MAX_IMPORT_IMAGES = 30;
const COOKIE = 'sid';

// 全站导入设置的机密字段
const SETTING_SECRETS = ['pixivSession', 'twitterAuth', 'twitterCt0'];

// maskSecret / maskAccount 是全站唯一实现，位于 bilibili-passport（扫码与路由共用同一 DTO）。

function validateTemplate(body) {
  const { name, content, variables = [], maxImages, category = 'dynamic', signatureFormat = '' } = body || {};
  if (!['dynamic', 'batch'].includes(category)) return { error: '模板类别必须为 dynamic 或 batch' };
  if (typeof signatureFormat !== 'string' || signatureFormat.length > 2000) return { error: '署名格式须为不超过 2000 字的文本' };
  const signatureKeys = ['author', 'handle', 'pixivId', 'sourceUrl'];
  if (extractVariableKeys(signatureFormat).some(k => !signatureKeys.includes(k) && k.toLowerCase() !== 'origauthor' && !Staff.isKey(k))) return { error: '署名格式仅支持 author、handle、pixivId、sourceUrl、origAuthor、staffN 及旧人员别名占位符' };
  if (!name || !String(name).trim()) return { error: '模板名称不能为空' };
  if (!content || !String(content).trim()) return { error: '模板内容不能为空' };
  if (!Array.isArray(variables)) return { error: '变量定义格式不正确' };
  const keys = new Set();
  for (const v of variables) {
    if (!v || !v.key || !/^[\w\u4e00-\u9fa5]+$/.test(v.key)) {
      return { error: '变量 Key 只能包含字母、数字、下划线或中文' };
    }
    if (keys.has(v.key)) return { error: `变量 Key 重复: ${v.key}` };
    keys.add(v.key);
  }
  return {
    tpl: {
      name: String(name).trim(),
      content: String(content),
      variables, category, signatureFormat: category === 'batch' ? signatureFormat : '',
      maxImages: Math.max(0, Math.min(MAX_IMAGES, (Number.isFinite(Number(maxImages)) ? Number(maxImages) : MAX_IMAGES)))
    }
  };
}

module.exports = function createRoutes(ctx) {
  const { store, storage, bili, scheduler, qrLogin, cookieRefresh } = ctx;
  const credentialsLock = ctx.credentialsLock || new AccountCredentialsLock();
  // X 凭据测试默认走 importers 真实实现；允许 ctx 注入（仅测试用），与其它服务同一种依赖注入风格
  const xTest = ctx.testXCredentials || testXCredentials;
  // 登录失败限速：允许注入（测试注入时钟），默认按启动时的配置创建
  const loginThrottle = ctx.loginThrottle || new LoginThrottle(config.login);
  const router = express.Router();

  router.use(attachUser(store));

  // 派生缓存不写 Store，鉴权和源存在性检查始终早于磁盘命中。
  const thumbConfig = thumbnailConfig();
  const thumbs = createThumbnailService({ storage, config: thumbConfig });
  router.get('/thumb/*', requireAuth, async (req, res) => {
    const controller = new AbortController();
    const disconnect = () => { if (!res.writableFinished) controller.abort(); };
    res.on('close', disconnect);
    let key, record;
    const fallback = () => {
      if (storage.name === 'local') return '/uploads/' + key.split('/').map(encodeURIComponent).join('/');
      try {
        const base = new URL(storage.cfg.publicBase);
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return null;
        const expected = base.href.replace(/\/+$/, '') + '/' + key.split('/').map(encodeURIComponent).join('/');
        return record.url && new URL(record.url).href === expected ? expected : null;
      } catch (e) { return null; }
    };
    try {
      key = validateKey(req.params[0]);
      if (Object.keys(req.query).some(k => k !== 'w') || (req.query.w !== undefined && !['240', '480'].includes(req.query.w))) {
        return res.status(400).json({ error: '非法缩略参数' });
      }
      // 与 /uploads 原图共用同一套归属判据（图库记录 + 可见任务快照）。
      record = findReadableImage(store, key, req.user);
      if (!record) return res.status(404).json({ error: '图片不存在' });
      const sourceMeta = await thumbs.metadata(key, controller.signal);
      if (!thumbConfig.enabled) {
        const url = fallback();
        return url ? res.set('Cache-Control', 'no-store').redirect(302, url) : res.status(502).json({ error: '无安全原图地址' });
      }
      const result = await thumbs.get({ key, width: Number(req.query.w || 240), sourceMeta, signal: controller.signal });
      res.set({ 'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=0, must-revalidate', 'Vary': 'Cookie', 'ETag': result.etag });
      if ((req.headers['if-none-match'] || '').split(',').map(s => s.trim().replace(/^W\//, '')).includes(result.etag) || req.headers['if-none-match'] === '*') return res.status(304).end();
      res.sendFile(result.file, err => { if (err && !res.headersSent && !res.destroyed) res.status(503).end(); });
    } catch (e) {
      if (res.destroyed) return;
      const code = e.code || e.name;
      if (code === 'BAD_KEY') return res.status(400).json({ error: '非法图片 key' });
      if (['ENOENT', 'NoSuchKey', 'NoSuchObject', 'NotFound'].includes(code) || e.$metadata?.httpStatusCode === 404) return res.status(404).json({ error: '图片不存在' });
      if (['OVERLOAD', 'ABORT_ERR'].includes(code)) return res.set('Retry-After', '5').status(503).json({ error: '缩略服务繁忙' });
      const url = record && fallback();
      return url ? res.set('Cache-Control', 'no-store').redirect(302, url) : res.status(502).json({ error: '缩略生成失败' });
    }
  });

  router.get('/health', (req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // 管理员视角：?scope=all 时可查看全部用户数据
  const scopeFilter = (req) => {
    const all = req.user && req.user.role === 'admin' && req.query.scope === 'all';
    return all ? () => true : (r) => r.userId === req.user.id;
  };
  const canTouch = (rec, req) =>
    rec.userId === req.user.id || req.user.role === 'admin';

  // ===================== 登录 / 会话 =====================
  router.post('/auth/login', async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ error: '请输入用户名和密码' });
      // 先看限速再看密码：被拦截的请求不消耗 scrypt，也不计入失败次数，
      // 否则持续爆破会让窗口永远不过期。
      const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
      const limit = loginThrottle.check(ip, username);
      if (!limit.allowed) {
        return res.set('Retry-After', String(limit.retryAfterSec))
          .status(429).json({ error: '登录失败次数过多，请稍后再试' });
      }
      const user = store.getUserByUsername(username);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        loginThrottle.fail(ip, username);
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      if (user.active === false) return res.status(403).json({ error: '该账号已被禁用，请联系管理员' });
      loginThrottle.succeed(ip, username);
      const token = store.createSession(user.id);
      await store.updateUser(user.id, { lastLoginAt: new Date().toISOString() });
      res.setHeader('Set-Cookie',
        `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
      res.json({ user: sanitizeUser(store.getUser(user.id)) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/auth/logout', (req, res) => {
    if (req.sessionToken) store.deleteSession(req.sessionToken);
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({ user: sanitizeUser(req.user) });
  });

  router.put('/auth/password', requireAuth, async (req, res, next) => {
    try {
      const { oldPassword, password } = req.body || {};
      if (!verifyPassword(oldPassword, req.user.passwordHash)) {
        return res.status(400).json({ error: '原密码不正确' });
      }
      if (!password || String(password).length < 6) {
        return res.status(400).json({ error: '新密码至少 6 位' });
      }
      await store.updatePassword(req.user.id, hashPassword(password));
      store.deleteSessionsFor(req.user.id);
      const token = store.createSession(req.user.id);
      res.setHeader('Set-Cookie',
        `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`);
      await store.addLog('info', `用户 ${req.user.username} 修改了自己的密码`, { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 用户管理（管理员） =====================
  router.get('/users', requireAdmin, (req, res) => {
    const users = store.listUsers().map((u) => ({
      ...u,
      jobsCount: store.listJobs().filter((j) => j.userId === u.id).length,
      imagesCount: store.listImages().filter((i) => i.userId === u.id).length
    }));
    res.json({ users });
  });

  router.post('/users', requireAdmin, async (req, res, next) => {
    try {
      const { username, name, password, role } = req.body || {};
      if (!username || !/^[a-zA-Z0-9_-]{2,20}$/.test(username)) {
        return res.status(400).json({ error: '用户名需 2-20 位字母、数字、下划线或中划线' });
      }
      if (store.getUserByUsername(username)) {
        return res.status(400).json({ error: '用户名已存在' });
      }
      if (!password || String(password).length < 6) {
        return res.status(400).json({ error: '密码至少 6 位' });
      }
      const user = await store.addUser({
        username,
        name: (name || '').trim() || username,
        role: role === 'admin' ? 'admin' : 'user',
        passwordHash: hashPassword(password)
      });
      await store.addLog('info',
        `管理员 ${req.user.username} 创建了用户 ${user.username}（${user.role === 'admin' ? '管理员' : '用户'}）`,
        { userId: req.user.id });
      res.json({ user: sanitizeUser(user) });
    } catch (e) {
      next(e);
    }
  });

  router.put('/users/:id', requireAdmin, async (req, res, next) => {
    try {
      const target = store.getUser(req.params.id);
      if (!target) return res.status(404).json({ error: '用户不存在' });
      const { name, role, active } = req.body || {};
      const patch = {};
      if (name !== undefined) patch.name = String(name).trim() || target.username;
      if (role !== undefined && role !== target.role) {
        if (target.id === req.user.id) return res.status(400).json({ error: '不能修改自己的角色' });
        if (target.role === 'admin' && store.activeAdminCount() <= 1) {
          return res.status(400).json({ error: '至少保留一名启用状态的管理员' });
        }
        patch.role = role === 'admin' ? 'admin' : 'user';
      }
      if (active !== undefined && active !== target.active) {
        if (target.id === req.user.id) return res.status(400).json({ error: '不能禁用自己' });
        if (target.role === 'admin' && active === false && store.activeAdminCount() <= 1) {
          return res.status(400).json({ error: '至少保留一名启用状态的管理员' });
        }
        patch.active = active === true;
        if (patch.active === false) store.deleteSessionsFor(target.id);
      }
      const updated = await store.updateUser(target.id, patch);
      await store.addLog('info', `管理员 ${req.user.username} 更新了用户 ${target.username} 的信息`,
        { userId: req.user.id });
      res.json({ user: sanitizeUser(updated) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/users/:id/password', requireAdmin, async (req, res, next) => {
    try {
      const target = store.getUser(req.params.id);
      if (!target) return res.status(404).json({ error: '用户不存在' });
      const { password } = req.body || {};
      if (!password || String(password).length < 6) {
        return res.status(400).json({ error: '密码至少 6 位' });
      }
      await store.updatePassword(target.id, hashPassword(password));
      store.deleteSessionsFor(target.id);
      await store.addLog('info', `管理员 ${req.user.username} 重置了用户 ${target.username} 的密码`,
        { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/users/:id', requireAdmin, async (req, res, next) => {
    try {
      const target = store.getUser(req.params.id);
      if (!target) return res.status(404).json({ error: '用户不存在' });
      if (target.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
      if (target.role === 'admin' && store.activeAdminCount() <= 1) {
        return res.status(400).json({ error: '至少保留一名启用状态的管理员' });
      }
      const files = store.listImages().filter((i) => i.userId === target.id);
      for (const f of files) await storage.delete(f.key).catch(() => {});
      await store.deleteUserCascade(target.id);
      await store.addLog('info', `管理员 ${req.user.username} 删除了用户 ${target.username} 及其全部数据`,
        { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 账号（B站 Cookie，按用户隔离） =====================
  const accountWrite = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // 同源判定只比 host：反代终止 TLS 时 req.protocol 与浏览器 Origin 的 scheme 可能不同，
    // 比 scheme 会误杀合法请求；跨站伪造的 Origin 一定落在别的主机名上。
    const origin = req.get('origin');
    let sameOrigin = true;
    if (origin) { try { sameOrigin = new URL(origin).host === req.get('host'); } catch (e) { sameOrigin = false; } }
    if (!req.is('application/json') || !sameOrigin || req.get('sec-fetch-site') === 'cross-site') return res.status(400).json({ error: '账号操作必须同源JSON请求' });
    next();
  };
  const accountError = (res, e) => {
    // 身份不符 = 409（扫码账号与目标账号/凭据不一致），超时 504，nav 业务错误 400，其余上游 502
    const status = e.status || (e.kind === 'identity' ? 409 : e.kind === 'timeout' ? 504 : e.stage === 'nav' && e.kind !== 'network' ? 400 : 502);
    const message = e instanceof PassportError ? passportFailureMessage(e) : e.status ? e.message : '账号操作失败，请稍后重试';
    return res.status(status).json({ error: message, ...(e instanceof PassportError ? { kind: e.kind, stage: e.stage, code: e.code } : {}) });
  };
  router.post('/accounts/qrcode', requireAuth, accountWrite, async (req, res) => {
    try {
      const body = req.body || {};
      if (Object.keys(body).some(k => !['name', 'accountId'].includes(k)) || (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 100)) || (body.accountId !== undefined && typeof body.accountId !== 'string')) return res.status(400).json({ error: '非法扫码参数' });
      if (body.accountId) { const a = store.getAccount(body.accountId); if (!a || !canTouch(a, req)) return res.status(404).json({ error: '账号不存在' }); }
      if (!qrLogin) return res.status(503).json({ error: '扫码服务未启用' });
      res.json(await qrLogin.generate({ userId: req.user.id, name: body.name || '', accountId: body.accountId }));
    } catch (e) { accountError(res, e); }
  });
  router.get('/accounts/qrcode/:loginId/poll', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!qrLogin) return res.status(503).json({ error: '扫码服务未启用' });
      const result = await qrLogin.poll({ userId: req.user.id, loginId: req.params.loginId });
      res.json(result); // QR服务只缓存并返回已脱敏DTO，不缓存原始凭据结果。
    } catch (e) { accountError(res, e); }
  });
  router.get('/accounts', requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ accounts: store.listAccounts().filter(scopeFilter(req)).map(maskAccount) });
  });

  router.post('/accounts', requireAuth, accountWrite, async (req, res, next) => {
    try {
      const { name, sessdata, bili_jct } = req.body || {};
      if (!sessdata || !bili_jct) {
        return res.status(400).json({ error: 'SESSDATA 和 bili_jct 均为必填' });
      }
      let profile;
      try { profile = await validateBiliCredentials(bili, { sessdata: String(sessdata).trim(), bili_jct: String(bili_jct).trim() }); }
      catch (e) { return accountError(res, e); }
      const d = { mid: profile.uid, uname: profile.uname, face: profile.avatar };
      const account = {
        id: genId('acc'),
        userId: req.user.id,
        name: (name || '').trim() || d.uname || '未命名账号',
        uid: d.mid,
        mid: String(d.mid),
        uname: d.uname,
        avatar: d.face || '',
        sessdata: String(sessdata).trim(),
        bili_jct: String(bili_jct).trim(),
        createdAt: new Date().toISOString()
      };
      await store.addAccount(account);
      await store.addLog('info', `新增B站账号: ${account.uname} (uid ${account.uid})`,
        { userId: req.user.id });
      res.json({ account: maskAccount(account) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/accounts/:id/reverify', requireAuth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { await credentialsLock.runExclusive(req.params.id, async () => {
      const acc = store.getAccount(req.params.id);
      if (!acc || !canTouch(acc, req)) return res.status(404).json({ error: '账号不存在' });
      let profile;
      try { profile = await validateBiliCredentials(bili, acc); }
      catch (e) {
        await store.updateAccount(acc.id, { cookieStatus: mergedNavStatus(acc, { code: e.code, message: passportFailureMessage(e) }, new Date().toISOString()) });
        return accountError(res, e);
      }
      await store.updateAccount(acc.id, { ...profile, cookieStatus: mergedNavStatus(acc, { code: 0 }, new Date().toISOString()) });
      await store.flushNow();
      res.json({ account: maskAccount(store.getAccount(acc.id)) });
    }); } catch (e) { accountError(res, e); }
  });

  // 修改 Cookie：先向B站校验，通过才覆盖，避免写坏数据
  router.put('/accounts/:id/cookie', requireAuth, accountWrite, async (req, res) => {
    try { await credentialsLock.runExclusive(req.params.id, async () => {
      const acc = store.getAccount(req.params.id);
      if (!acc || !canTouch(acc, req)) return res.status(404).json({ error: '账号不存在' });
      const body = req.body || {};
      if (Object.keys(body).some(k => !['sessdata', 'bili_jct', 'name', 'refreshToken'].includes(k)) || Object.values(body).some(v => typeof v !== 'string')) return res.status(400).json({ error: '非法Cookie字段' });
      const sessdata = (body.sessdata || '').trim(), bili_jct = (body.bili_jct || '').trim(), refreshToken = (body.refreshToken || '').trim();
      if (!sessdata || !bili_jct || [sessdata, bili_jct, refreshToken].some(v => /[\r\n]/.test(v))) return res.status(400).json({ error: 'SESSDATA 和 bili_jct 均为必填，且不得包含换行' });
      let profile; try { profile = await validateBiliCredentials(bili, { sessdata, bili_jct }); }
      catch (e) {
        // 校验失败只更新红显状态，绝不替换现存 Cookie/token（网络/身份不符不改动既有健康状态）
        if (e.kind !== 'network' && e.kind !== 'identity') {
          await store.updateAccount(acc.id, { cookieStatus: mergedNavStatus(acc, { code: e.code, message: passportFailureMessage(e) }, new Date().toISOString()) });
        }
        return accountError(res, e);
      }
      if (acc.mid || acc.uid) { if (String(acc.mid || acc.uid) !== profile.mid) return res.status(400).json({ error: '不能修改为另一B站身份，请新增账号' }); }
      const changed = sessdata !== acc.sessdata || bili_jct !== acc.bili_jct;
      const newChain = changed || Boolean(refreshToken);
      const patch = { sessdata, bili_jct, ...profile, cookieStatus: newChain ? { ok: true, code: 0, message: '', checkedAt: new Date().toISOString() } : mergedNavStatus(acc, { code: 0 }, new Date().toISOString()) };
      if (changed) Object.assign(patch, { refreshToken: undefined, sid: undefined, dedeUserID: undefined, dedeUserIDCheckMd5: undefined });
      if (refreshToken) patch.refreshToken = refreshToken;
      if (newChain) patch.lastCookieRefreshAt = undefined;
      if ((body.name || '').trim()) patch.name = body.name.trim();
      await store.updateAccount(acc.id, patch); await store.flushNow();
      if (newChain && cookieRefresh) {
        // 新链已落库；清理旧恢复记录失败只降级记录，不能让用户以为保存失败。
        try { await cookieRefresh.clearPending(acc.id); }
        catch (e) { await store.addLog('warn', `账号 ${acc.id}：续期恢复记录清理失败`, { userId: req.user.id }); }
      }
      await store.addLog('info', `账号 ${acc.id}：Cookie 已更新并校验通过`, { userId: req.user.id });
      res.json({ account: maskAccount(store.getAccount(acc.id)) });
    }); } catch (e) { accountError(res, e); }
  });

  router.delete('/accounts/:id', requireAuth, async (req, res, next) => {
    try { await credentialsLock.runExclusive(req.params.id, async () => {
      const acc = store.getAccount(req.params.id);
      if (!acc || !canTouch(acc, req)) return res.status(404).json({ error: '账号不存在' });
      const used = store.listJobs().filter(
        (j) => j.accountId === acc.id && ['pending', 'publishing'].includes(j.status)
      );
      if (used.length) {
        return res.status(400).json({
          error: `该账号仍有 ${used.length} 个待发布/发布中的任务，请先删除或改绑这些任务`
        });
      }
      await store.deleteAccount(acc.id);
      await store.flushNow();
      if (cookieRefresh) { try { await cookieRefresh.clearPending(acc.id); } catch (e) { await store.addLog('warn', `账号 ${acc.id}：续期恢复记录清理失败`, { userId: req.user.id }); } }
      await store.addLog('info', `删除B站账号: ${acc.uname}`, { userId: req.user.id });
      res.json({ ok: true });
    }); } catch (e) {
      next(e);
    }
  });

  // ===================== 模板（按用户隔离） =====================
  router.get('/templates', requireAuth, (req, res) => {
    const { category } = req.query;
    if (category !== undefined && !['dynamic', 'batch'].includes(category)) return res.status(400).json({ error: '模板类别不正确' });
    res.json({ templates: store.listTemplates().filter(scopeFilter(req)).filter(t => !category || (t.category || 'dynamic') === category) });
  });

  router.post('/templates', requireAuth, async (req, res, next) => {
    try {
      const { error, tpl } = validateTemplate(req.body);
      if (error) return res.status(400).json({ error });
      const created = { id: genId('tpl'), userId: req.user.id, ...tpl };
      await store.addTemplate(created);
      await store.addLog('info', `新建模板: ${created.name}`, { userId: req.user.id });
      res.json({ template: created });
    } catch (e) {
      next(e);
    }
  });

  router.put('/templates/:id', requireAuth, async (req, res, next) => {
    try {
      const tpl = store.getTemplate(req.params.id);
      if (!tpl || !canTouch(tpl, req)) return res.status(404).json({ error: '模板不存在' });
      const { error, tpl: body } = validateTemplate({ ...req.body, category: req.body.category ?? tpl.category ?? 'dynamic', signatureFormat: req.body.signatureFormat ?? tpl.signatureFormat ?? '' });
      if (error) return res.status(400).json({ error });
      const updated = await store.updateTemplate(tpl.id, body);
      await store.addLog('info', `更新模板: ${updated.name}`, { userId: req.user.id });
      res.json({ template: updated });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/templates/:id', requireAuth, async (req, res, next) => {
    try {
      const tpl = store.getTemplate(req.params.id);
      if (!tpl || !canTouch(tpl, req)) return res.status(404).json({ error: '模板不存在' });
      await store.deleteTemplate(tpl.id);
      await store.addLog('info', `删除模板: ${tpl.name}`, { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 图库文件夹 =====================
  router.get('/folders', requireAuth, (req, res) => {
    res.json({ folders: store.listFolders().filter(scopeFilter(req)) });
  });

  router.post('/folders', requireAuth, async (req, res, next) => {
    try {
      const name = String((req.body && req.body.name) || '').trim();
      if (!name || name.length > 20) return res.status(400).json({ error: '文件夹名称需 1-20 个字' });
      const dup = store.listFolders().find((f) => f.userId === req.user.id && f.name === name);
      if (dup) return res.status(400).json({ error: '同名文件夹已存在' });
      const folder = { id: genId('fld'), userId: req.user.id, name, createdAt: new Date().toISOString() };
      await store.addFolder(folder);
      res.json({ folder });
    } catch (e) {
      next(e);
    }
  });

  router.put('/folders/:id', requireAuth, async (req, res, next) => {
    try {
      const f = store.getFolder(req.params.id);
      if (!f || !canTouch(f, req)) return res.status(404).json({ error: '文件夹不存在' });
      const name = String((req.body && req.body.name) || '').trim();
      if (!name || name.length > 20) return res.status(400).json({ error: '文件夹名称需 1-20 个字' });
      const dup = store.listFolders().find((x) => x.userId === f.userId && x.name === name && x.id !== f.id);
      if (dup) return res.status(400).json({ error: '同名文件夹已存在' });
      await store.updateFolder(f.id, { name });
      res.json({ folder: store.getFolder(f.id) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/folders/:id', requireAuth, async (req, res, next) => {
    try {
      const f = store.getFolder(req.params.id);
      if (!f || !canTouch(f, req)) return res.status(404).json({ error: '文件夹不存在' });
      await store.deleteFolder(f.id);
      await store.addLog('info', `删除文件夹「${f.name}」，其中图片已移至未分类`, { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  router.post('/images/move', requireAuth, async (req, res, next) => {
    try {
      const { keys, folderId } = req.body || {};
      if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: '未选择图片' });
      let folder = null;
      if (folderId && folderId !== 'none') {
        folder = store.getFolder(folderId);
        if (!folder || !canTouch(folder, req)) return res.status(400).json({ error: '目标文件夹不存在' });
      }
      let moved = 0;
      for (const k of keys) {
        const img = store.listImages().find((i) => i.key === k);
        if (!img || !canTouch(img, req)) continue;
        img.folderId = folder ? folder.id : null;
        moved++;
      }
      store.save();
      res.json({ ok: true, moved });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 全站导入设置（管理员） =====================
  function settingsView() {
    const s = store.getSettings();
    return {
      pixivSession: maskSecret(s.pixivSession),
      twitterAuth: maskSecret(s.twitterAuth),
      twitterCt0: maskSecret(s.twitterCt0),
      importProxy: s.importProxy || '',
      hasPixivSession: !!s.pixivSession,
      hasTwitterAuth: !!s.twitterAuth,
      hasTwitterCt0: !!s.twitterCt0
    };
  }

  router.get('/settings', requireAdmin, (req, res) => {
    res.json({ settings: settingsView() });
  });

  router.put('/settings', requireAdmin, async (req, res, next) => {
    try {
      const patch = {};
      const body = req.body || {};
      if (Object.keys(body).some(k => /danbooru|donmai/i.test(k))) return res.status(400).json({ error: '该图源设置已移除' });
      for (const k of SETTING_SECRETS) {
        // 机密字段：留空 / 等于掩码值 → 不修改；显式传新值（含空串）→ 覆盖
        if (body[k] !== undefined && body[k] !== '' && body[k] !== settingsView()[k]) {
          patch[k] = String(body[k]).trim();
        }
      }
      if (body.importProxy !== undefined) patch.importProxy = String(body.importProxy).trim();
      await store.updateSettings(patch);
      await store.addLog('info', `管理员 ${req.user.username} 更新了全站导入设置`, { userId: req.user.id });
      res.json({ settings: settingsView() });
    } catch (e) {
      next(e);
    }
  });

  // X 账号测试：用**当前已保存**的 auth_token/ct0（及代理）真实请求 X 的 verify_credentials。
  // 响应白名单化，只出 ok/handle/name/reason，绝不回显凭据。
  router.post('/settings/x-test', requireAdmin, async (req, res, next) => {
    try {
      const s = store.getSettings();
      const r = await xTest({
        authToken: s.twitterAuth || '',
        ct0: s.twitterCt0 || '',
        proxy: s.importProxy || '',
        timeout: 15000
      });
      const payload = r && r.ok
        ? { ok: true, handle: String(r.handle || ''), name: String(r.name || '') }
        : { ok: false, reason: String((r && r.reason) || '测试失败，请稍后再试') };
      try {
        await store.addLog('info', payload.ok
          ? `管理员 ${req.user.username} 测试 X 凭据：可用（${payload.handle}）`
          : `管理员 ${req.user.username} 测试 X 凭据：不可用（${payload.reason}）`, { userId: req.user.id });
      } catch (e) { /* 日志失败不影响测试结果 */ }
      res.json(payload);
    } catch (e) {
      next(e);
    }
  });

  // ===================== 作品解析（流式进度，PRD F-D1~F-D3） =====================
  const PARSE_ERRORS = {
    invalid: { t: '无法识别的链接', s: '仅支持 X(Twitter) 与 Pixiv 的作品页链接。示例：x.com/用户名/status/ID、pixiv.net/artworks/ID' },
    notfound: { t: '链接失效或不存在的作品', s: '该作品可能已被删除，或链接中的作品 ID 有误' },
    restricted: { t: '需要登录或为限制级作品', s: '该作品需要登录或为 R-18 内容，无法直接抓取。请手动保存图片后通过「上传图片」添加' },
    deleted: { t: '推文已删除或不可见', s: '该推文可能已被作者删除，或对你当前 X 账号不可见。请先在浏览器里确认链接能正常打开；凭据与代理无需再调整。' },
    timeout: { t: '网络超时', s: '请求超过 8 秒未响应，请重试' },
    network: { t: '网络错误', s: '请求失败，请检查网络或代理设置后重试' }
  };

  router.post('/library/parse-work', requireAuth, async (req, res) => {
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ error: '请输入链接' });
    let folderId = null;
    const fid = String((req.body && req.body.folderId) || '');
    if (fid && fid !== 'none') {
      const folder = store.getFolder(fid);
      if (!folder || folder.userId !== req.user.id) {
        return res.status(400).json({ error: '目标文件夹不存在' });
      }
      folderId = folder.id;
    }

    // NDJSON 流式输出：progress 事件 + done/error 事件
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('x-accel-buffering', 'no');
    const send = (obj) => { try { res.write(JSON.stringify(obj) + '\n'); } catch (e) { /* ignore */ } };
    const flush = () => { try { res.flush && res.flush(); } catch (e) { /* ignore */ } };

    let done = 0;
    const onProgress = (stepIndex, subText) => {
      done = stepIndex + 1;
      send({ type: 'progress', step: stepIndex, done, sub: subText || '' });
      flush();
    };

    try {
      const { work, images, total = images.length } = await parseWork(url, store.getSettings(), onProgress, MAX_IMPORT_IMAGES);
      const saved = [];
      for (const it of images) {
        if (!it.buffer || !it.buffer.length) continue;
        const { key, url: imgUrl } = await storage.put(it.buffer, it.name, it.contentType);
        const meta = {
          key, userId: req.user.id, folderId,
          name: it.name || key, url: imgUrl, size: it.buffer.length,
          contentType: it.contentType, createdAt: new Date().toISOString()
        };
        await store.addImage(meta);
        saved.push(meta);
      }
      await store.addLog('info', `链接解析：${work.title} → ${saved.length} 张原图入库（${url.slice(0, 80)}）`, { userId: req.user.id });
      send({ type: 'done', step: 4, work, images: saved, total });
      res.end();
    } catch (e) {
      const code = (e && e.code && PARSE_ERRORS[e.code]) ? e.code : 'network';
      console.error(`[parse-work] ${code} url=${String(url).slice(0, 120)} err=${(e && e.message || e).toString().slice(0, 200)}`); // 排障日志：url 截断，无凭据
      send({ type: 'error', step: Math.min(done, 3), error: code, message: PARSE_ERRORS[code].t });
      res.end();
    }
  });

  // ===================== 作者解析（轻量，只取作品元数据不下载图片） =====================
  // 从 Pixiv 作品链接读取作者元数据。
  router.post('/library/parse-source', requireAuth, async (req, res) => {
    try {
      const source = String((req.body && req.body.source) || '').trim();
      if (!source) return res.status(400).json({ error: '缺少 source' });
      const info = await parseSource(source, store.getSettings());
      res.json(info);
    } catch (e) {
      res.status(400).json({ error: (e && e.code) || 'parse-failed' });
    }
  });

  // ===================== 链接导入图库 =====================
  router.post('/library/import', requireAuth, async (req, res, next) => {
    try {
      const url = String((req.body && req.body.url) || '').trim();
      if (!url) return res.status(400).json({ error: '请输入链接' });
      let folderId = null;
      const fid = String((req.body && req.body.folderId) || '');
      if (fid && fid !== 'none') {
        const folder = store.getFolder(fid);
        if (!folder || folder.userId !== req.user.id) {
          return res.status(400).json({ error: '目标文件夹不存在' });
        }
        folderId = folder.id;
      }
      let items;
      try {
        items = await importFromUrl(url, store.getSettings(), MAX_IMPORT_IMAGES);
      } catch (e) {
        if (e instanceof ImportError) return res.status(400).json({ error: e.message });
        throw e;
      }
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: '未从该链接获取到图片' });
      }
      const total = items.total ?? items.length;
      const saved = [];
      for (const it of items) {
        if (!it.buffer || !it.buffer.length) continue;
        const { key, url: imgUrl } = await storage.put(it.buffer, it.name, it.contentType);
        const meta = {
          key,
          userId: req.user.id,
          folderId,
          name: it.name || key,
          url: imgUrl,
          size: it.buffer.length,
          contentType: it.contentType,
          createdAt: new Date().toISOString()
        };
        await store.addImage(meta);
        saved.push(meta);
      }
      if (!saved.length) return res.status(400).json({ error: '导入失败：没有可用图片' });
      await store.addLog('info',
        `链接导入 ${saved.length} 张图片${total > MAX_IMPORT_IMAGES ? `（超出上限，已截取前 ${MAX_IMPORT_IMAGES} 张）` : ''}: ${url.slice(0, 100)}`,
        { userId: req.user.id });
      res.json({ images: saved, total });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 图片上传 / 图库（按用户隔离） =====================
  router.get('/images', requireAuth, (req, res) => {
    res.json({ images: store.listImages().filter(scopeFilter(req)) });
  });

  // 普通上传与草稿上传共用入库逻辑，保留文件名修复、用户归属及元数据。
  async function saveUploadedImages(files, userId, folderId) {
    const saved = [];
    for (const f of files) {
      if (!f.mimetype || !f.mimetype.startsWith('image/')) continue;
      if (!f.buffer || !f.buffer.length) continue;
      const originalname = decodeMojibakeName(f.originalname);
      const { key, url } = await storage.put(f.buffer, originalname, f.mimetype);
      const meta = {
        key, userId, folderId, name: originalname || key, url,
        size: f.size, contentType: f.mimetype, createdAt: new Date().toISOString()
      };
      await store.addImage(meta);
      saved.push(meta);
    }
    return saved;
  }

  router.post('/upload', requireAuth, (req, res) => {
    upload.array('files', MAX_IMAGES)(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      try {
        const files = req.files || [];
        // 上传时可指定目标文件夹（须属于当前用户）
        let folderId = null;
        const fid = String((req.body && req.body.folderId) || '');
        if (fid && fid !== 'none') {
          const folder = store.getFolder(fid);
          if (!folder || folder.userId !== req.user.id) {
            return res.status(400).json({ error: '目标文件夹不存在' });
          }
          folderId = folder.id;
        }
        const saved = await saveUploadedImages(files, req.user.id, folderId);
        if (!saved.length) {
          return res.status(400).json({ error: '没有可用的图片（仅支持 jpg/png/gif/webp/bmp/avif）' });
        }
        res.json({ images: saved });
      } catch (e) {
        res.status(500).json({ error: '上传失败: ' + e.message });
      }
    });
  });

  router.post('/images/delete', requireAuth, async (req, res, next) => {
    try {
      const { key } = req.body || {};
      const img = store.listImages().find((i) => i.key === key);
      if (!img || !canTouch(img, req)) return res.status(404).json({ error: '图片不存在' });
      const used = store.listJobs().filter(
        (j) => ['pending', 'publishing'].includes(j.status) && (j.images || []).some((i) => i.key === key)
      );
      if (used.length) {
        return res.status(400).json({ error: `该图片正被 ${used.length} 个待发布任务使用，请先在任务中移除` });
      }
      await storage.delete(key).catch(() => {});
      await store.deleteImage(key);
      await store.addLog('info', `删除图片: ${key}`, { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // 图片是否被待发布/发布中任务引用
  function imageInUse(key) {
    return store.listJobs().some(
      (j) => ['pending', 'publishing'].includes(j.status) && (j.images || []).some((i) => i.key === key)
    );
  }

  // 批量删除（PRD：图库多选批量操作）
  router.post('/images/delete-batch', requireAuth, async (req, res, next) => {
    try {
      const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
      if (!keys.length) return res.status(400).json({ error: '未选择图片' });
      let deleted = 0;
      const skipped = [];
      for (const key of keys) {
        const img = store.listImages().find((i) => i.key === key);
        if (!img || !canTouch(img, req)) { skipped.push({ key, reason: '不存在' }); continue; }
        if (imageInUse(key)) { skipped.push({ key, name: img.name, reason: '被待发布任务使用' }); continue; }
        await storage.delete(key).catch(() => {});
        await store.deleteImage(key);
        deleted++;
      }
      await store.addLog('info', `批量删除图片 ${deleted} 张${skipped.length ? `（跳过 ${skipped.length} 张）` : ''}`, { userId: req.user.id });
      res.json({ deleted, skipped });
    } catch (e) {
      next(e);
    }
  });

  // 清空当前视图（PRD：一键清空）
  router.post('/images/clear', requireAuth, async (req, res, next) => {
    try {
      const view = String((req.body && req.body.view) || 'none');
      const pool = store.listImages().filter(scopeFilter(req));
      const targets = pool.filter((i) =>
        view === 'all' ? true : view === 'none' ? !i.folderId : i.folderId === view);
      let deleted = 0;
      let blocked = 0;
      for (const img of targets) {
        if (imageInUse(img.key)) { blocked++; continue; }
        await storage.delete(img.key).catch(() => {});
        await store.deleteImage(img.key);
        deleted++;
      }
      await store.addLog('info', `清空图库视图（${view}）：删除 ${deleted} 张${blocked ? `，${blocked} 张因被待发布任务引用跳过` : ''}`, { userId: req.user.id });
      res.json({ deleted, blocked, total: targets.length });
    } catch (e) {
      next(e);
    }
  });

  // 导出为 ZIP（PRD：批量导出）
  router.post('/images/export', requireAuth, async (req, res, next) => {
    try {
      const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys : [];
      if (!keys.length) return res.status(400).json({ error: '未选择图片' });
      const used = new Set();
      const entries = [];
      let lost = 0;
      for (const key of keys) {
        const img = store.listImages().find((i) => i.key === key);
        if (!img || !canTouch(img, req)) { lost++; continue; }
        let buf;
        try {
          const got = await storage.get(key);
          buf = got.buffer;
        } catch (e) { lost++; continue; }
        let name = String(img.name || key).replace(/[\\/:*?"<>|\r\n\t]+/g, '_').slice(0, 120) || 'image';
        if (used.has(name)) {
          const dot = name.lastIndexOf('.');
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : '';
          let n = 2;
          while (used.has(`${stem}(${n})${ext}`)) n++;
          name = `${stem}(${n})${ext}`;
        }
        used.add(name);
        entries.push({ name, buffer: buf, mtime: new Date(img.createdAt || Date.now()) });
      }
      if (!entries.length) return res.status(400).json({ error: '没有可导出的图片（可能文件已丢失）' });
      const zip = buildZip(entries);
      const d = new Date();
      const ts = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="380nm-images-${ts}.zip"`);
      res.send(zip);
    } catch (e) {
      next(e);
    }
  });

  // ===================== 元数据：内容类型 / 署名槽位 =====================
  // 标签（TAG）功能已下线：任务改用「模板」区分，不再有标签维度
  router.get('/tags', requireAuth, (req, res) => {
    res.json({ types: TASK_TYPES, typeSlots: TYPE_SLOTS, slotLabels: SLOT_LABELS });
  });

  // ===================== 账号库（署名成员目录，不区分角色） =====================
  const LIB_STATUSES = ['在岗', '离岗'];
  const validateLibAccount = (body) => {
    const name = String((body && body.name) || '').trim();
    const handle = String((body && body.handle) || '').trim().replace(/^@/, '');
    // 已移除 role：账号库不再按角色分类，翻译 / 嵌字 共用同一份人员清单
    const status = String((body && body.status) || '在岗').trim();
    const uid = String((body && body.uid) || '').trim();
    if (!name || name.length > 30) return { error: '账号名需 1-30 个字' };
    if (!handle || handle.length > 30) return { error: 'handle 需 1-30 个字符（不含 @）' };
    if (!LIB_STATUSES.includes(status)) return { error: '在岗状态需为 在岗 / 离岗' };
    if (uid && !/^\d+$/.test(uid)) return { error: 'B站 uid 需为纯数字' };
    return { acc: { name, handle, status, uid } };
  };

  router.get('/lib-accounts', requireAuth, (req, res) => {
    res.json({ accounts: store.listLibAccounts().filter(scopeFilter(req)) });
  });

  router.post('/lib-accounts', requireAuth, async (req, res, next) => {
    try {
      const { error, acc } = validateLibAccount(req.body);
      if (error) return res.status(400).json({ error });
      const dup = store.listLibAccounts().find((a) => a.userId === req.user.id && a.handle === acc.handle);
      if (dup) return res.status(400).json({ error: '相同 handle 的账号已存在' });
      const created = { id: genId('lib'), userId: req.user.id, ...acc, createdAt: new Date().toISOString() };
      await store.addLibAccount(created);
      res.json({ account: created });
    } catch (e) {
      next(e);
    }
  });

  router.put('/lib-accounts/:id', requireAuth, async (req, res, next) => {
    try {
      const target = store.getLibAccount(req.params.id);
      if (!target || !canTouch(target, req)) return res.status(404).json({ error: '账号不存在' });
      const { error, acc } = validateLibAccount(req.body);
      if (error) return res.status(400).json({ error });
      const dup = store.listLibAccounts().find((a) => a.userId === target.userId && a.handle === acc.handle && a.id !== target.id);
      if (dup) return res.status(400).json({ error: '相同 handle 的账号已存在' });
      const updated = await store.updateLibAccount(target.id, acc);
      res.json({ account: updated });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/lib-accounts/:id', requireAuth, async (req, res, next) => {
    try {
      const target = store.getLibAccount(req.params.id);
      if (!target || !canTouch(target, req)) return res.status(404).json({ error: '账号不存在' });
      await store.deleteLibAccount(target.id);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 内容类型（已挂载于 /tags） =====================

  // ===================== 话题搜索 =====================
  router.get('/topics/search', requireAuth, async (req, res, next) => {
    try {
      const keywords = String(req.query.keywords || '').trim().replace(/^#|#$/g, '');
      if (!keywords) return res.status(400).json({ error: '请输入话题关键词' });
      let acc = req.query.accountId ? store.getAccount(req.query.accountId) : null;
      if (acc && acc.userId !== req.user.id && req.user.role !== 'admin') acc = null;
      if (!acc) acc = store.listAccounts().find((a) => a.userId === req.user.id);
      if (!acc) return res.status(400).json({ error: '请先在「账号管理」添加B站账号，再搜索话题' });
      const topics = await bili.searchTopic({ sessdata: acc.sessdata, keywords });
      res.json({ topics });
    } catch (e) {
      next(e);
    }
  });

  router.get('/topics/recent', requireAuth, (req, res) => {
    res.json({ topics: req.user.recentTopics || [] });
  });

  // ===================== @人搜索 =====================
  router.get('/mentions/search', requireAuth, async (req, res, next) => {
    try {
      const keywords = String(req.query.keywords || '').replace(/^@/, '').trim();
      if (!keywords) return res.status(400).json({ error: '请输入用户关键词' });
      let acc = req.query.accountId ? store.getAccount(req.query.accountId) : null;
      if (acc && acc.userId !== req.user.id && req.user.role !== 'admin') acc = null;
      if (!acc) acc = store.listAccounts().find((a) => a.userId === req.user.id);
      if (!acc) return res.status(400).json({ error: '请先在「账号管理」添加B站账号，再搜索用户' });
      const users = await bili.searchMention({ sessdata: acc.sessdata, keywords });
      res.json({ users });
    } catch (e) {
      next(e);
    }
  });

  // 署名槽位解析（PRD F-Q5/Q6）：按内容类型校验必需槽位，并从账号库快照 {id,name,handle,uid}
  function resolveSlots(body, type, userId) {
    const need = TYPE_SLOTS[type] || [];
    const raw = (body && body.slots) || {};
    const pick = (k) => {
      const v = raw[k];
      return v && typeof v === 'object' ? v.id : v;
    };
    const slots = {};
    for (const k of need) {
      const id = pick(k);
      if (!id) return { error: `请先绑定 ${SLOT_LABELS[k] || k}，未绑定的 @ 无法发布` };
      const entry = store.getLibAccount(String(id));
      if (!entry || entry.userId !== userId) return { error: `${SLOT_LABELS[k] || k} 对应的账号不存在` };
      slots[k] = { id: entry.id, name: entry.name, handle: entry.handle, uid: entry.uid || '' };
    }
    // 切换类型时保留仍有效、但新类型不必需的已绑定槽位（PRD F-Q5 规则1）
    for (const k of ['trans', 'typo', 'orig']) {
      if (slots[k] || need.includes(k)) continue;
      const id = pick(k);
      if (!id) continue;
      const entry = store.getLibAccount(String(id));
      if (entry && entry.userId === userId) {
        slots[k] = { id: entry.id, name: entry.name, handle: entry.handle, uid: entry.uid || '' };
      }
    }
    return { slots };
  }

  // 解析任务话题：优先使用已有 id，否则按名称搜索（精确匹配优先）
  async function resolveTopic(user, account, rawTopic) {
    const name = String((rawTopic && rawTopic.name) || '').trim().replace(/^#|#$/g, '');
    if (!name) return null;
    let id = Number(rawTopic && rawTopic.id) || 0;
    if (!id) {
      const found = await bili.searchTopic({ sessdata: account.sessdata, keywords: name });
      const hit = found.find((t) => t.name === name) || found[0];
      if (!hit) throw Object.assign(new Error(`未找到话题「${name}」，请在搜索结果中选择`), { status: 400 });
      id = hit.id;
    }
    return { id, name };
  }

  // 记录用户最近使用的话题（去重，最多 8 个）
  function pushRecentTopic(userId, topic) {
    if (!topic || !topic.id || !topic.name) return;
    const u = store.getUser(userId);
    if (!u) return;
    const list = (u.recentTopics || []).filter((t) => t.id !== topic.id);
    list.unshift({ id: topic.id, name: topic.name });
    u.recentTopics = list.slice(0, 8);
    store.save();
  }

  // 解析任务中的 @提及：uid 缺失时按名称搜索（精确匹配优先）
  async function resolveMentions(user, account, rawMentions) {
    if (!Array.isArray(rawMentions)) return [];
    const out = [];
    for (const m of rawMentions.slice(0, 10)) {
      const name = String((m && m.name) || '').replace(/^@/, '').trim();
      if (!name) continue;
      let uid = String((m && m.uid) || '').trim();
      if (!uid || !/^\d+$/.test(uid)) {
        const found = await bili.searchMention({ sessdata: account.sessdata, keywords: name });
        const hit = found.find((x) => x.name === name) || found[0];
        if (!hit) throw Object.assign(new Error(`未找到用户「${name}」，请在搜索结果中选择`), { status: 400 });
        uid = hit.uid;
      }
      if (!out.some((x) => x.uid === uid)) out.push({ uid, name });
    }
    return out;
  }

  // ===================== 发布队列（按用户隔离） =====================
  router.get('/jobs', requireAuth, (req, res) => {
    res.json({ jobs: store.listJobs().filter(scopeFilter(req)).map(job => Staff.staffView(job, store.listLibAccounts())) });
  });

  // 抽取的任务创建逻辑（供单条与批量复用）
  function jobInputError(message, status = 400) {
    const err = new Error(message);
    err.status = status;
    return err;
  }

  async function createJobFromInput(user, body, { deferred = false, batch = false } = {}) {
    const { templateId, accountId, variables = {}, images = [], scheduledAt } = body || {};

    const template = store.getTemplate(templateId);
    if (!template || template.userId !== user.id) {
      throw jobInputError('模板不存在');
    }
    const account = store.getAccount(accountId);
    if (!account || account.userId !== user.id) {
      throw jobInputError('请选择要发布的B站账号');
    }

    const staff = Staff.hasStaff(body) ? Staff.resolveStaff(body, store.listLibAccounts(), user.id) : undefined;
    const text = renderBody(template, variables, staff).trim();
    if (!text) throw jobInputError('动态内容为空，请填写模板变量');

    const limit = Math.max(0, Math.min(MAX_IMAGES, template.maxImages ?? MAX_IMAGES));
    if (images.length > limit) {
      throw jobInputError(`图片数量超出限制（模板最多 ${limit} 张）`);
    }
    for (const i of images) {
      const img = store.listImages().find((x) => x.key === i.key);
      if (!img || img.userId !== user.id) {
        throw jobInputError('包含不属于当前用户的图片');
      }
    }

    let when = scheduledAt ? new Date(scheduledAt) : new Date();
    if (isNaN(when.getTime())) throw jobInputError('计划时间格式不正确');
    if (when.getTime() < Date.now()) when = new Date(); // 已过时间按立即发布处理

    let topic = null;
    try {
      topic = await resolveTopic(user, account, body.topic);
    } catch (e) {
      throw jobInputError(e.message, e.status || 500);
    }

    let title = String((body && body.title) || '').trim();
    if (title.length > 20) throw jobInputError('动态标题最多 20 个字');

    let mentions = [];
    try {
      mentions = await resolveMentions(user, account, body.mentions);
    } catch (e) {
      throw jobInputError(e.message, e.status || 500);
    }
    mentions = mergeLibraryMentions(text, store.listLibAccounts(), mentions, user.id);

    const type = TASK_TYPES.includes(body.type) ? body.type : '原创';
    const slotsR = resolveSlots(body, type, user.id);
    if (slotsR.error) throw jobInputError(slotsR.error);

    const job = {
      id: genId('job'),
      userId: user.id,
      templateId: template.id,
      templateName: template.name,
      variables: staff === undefined ? variables : Staff.variables(variables, staff),
      staff: staff || Staff.readStaff({ userId: user.id, variables }, store.listLibAccounts()),
      accountId: account.id,
      accountName: account.uname || account.name,
      text,
      images: images.map((i) => ({ key: i.key, name: i.name || '', url: i.url || '' })),
      topic,
      title,
      mentions,
      type,
      slots: slotsR.slots,
      scheduledAt: when.toISOString(),
      status: 'pending',
      attempts: 0,
      lastError: null,
      publishedAt: null,
      dynamicId: '',
      dynamicUrl: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    if (deferred) {
      // 批量模式：使用 Silent 方法，不立即 save
      store.addJobSilent(job);
      if (topic && batch) pushRecentTopicSilent(user.id, topic);
      if (batch) {
        store.addLogSilent('info', `批量入队任务：${job.title}`, { jobId: job.id, userId: user.id });
      }
    } else {
      // 单条模式：使用原有方法，立即 save
      await store.addJob(job);
      if (topic) pushRecentTopic(user.id, topic);
      await store.addLog(
        'info',
        `任务加入队列: ${template.name} -> ${job.accountName}，计划 ${when.toLocaleString('zh-CN')}`,
        { jobId: job.id, userId: user.id }
      );
    }

    return job;
  }

  // ===================== 草稿（始终仅本人，不提供管理员越权） =====================
  // incomplete 始终派生，不信任客户端或旧数据中可能遗留的标记。
  function draftView(draft) {
    return { ...Staff.staffView(draft, store.listLibAccounts()), incomplete: !String(draft.text || '').trim() || !String(draft.scheduledAt || '').trim() };
  }

  router.post('/drafts/upload', requireAuth, (req, res) => {
    upload.array('files', MAX_IMAGES)(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      try {
        const files = (req.files || []).filter((f) => f.mimetype && f.mimetype.startsWith('image/') && f.buffer && f.buffer.length);
        if (!files.length) return res.status(400).json({ error: '没有可用的图片（仅支持 jpg/png/gif/webp/bmp/avif）' });
        const template = store.getTemplate((req.body || {}).templateId);
        if (!template || template.userId !== req.user.id) return res.status(400).json({ error: '模板不存在' });
        const topicName = String((req.body || {}).topic || '').trim();
        if (topicName.length > 100) return res.status(400).json({ error: '话题名称最多 100 个字' });
        const topic = topicName ? { name: topicName } : null;
        const now = new Date();
        const pad = (value) => String(value).padStart(2, '0');
        // 每次生成独立 ID；同一分钟重复上传也不会混入上次的文件夹。
        const folder = {
          id: genId('fld'), userId: req.user.id,
          name: `草稿 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
          createdAt: now.toISOString()
        };
        await store.addFolder(folder);
        const images = await saveUploadedImages(files, req.user.id, folder.id);
        const drafts = [];
        for (const image of images) {
          const draft = await store.addDraft({
            id: genId('draft'), userId: req.user.id, title: '', text: '',
            images: [{ key: image.key, name: image.name, url: image.url }],
            topic, type: '原创', slots: {}, staff: [], templateId: template.id, templateName: template.name, variables: {},
            createdAt: folder.createdAt, updatedAt: folder.createdAt
          });
          drafts.push(draftView(draft));
        }
        res.json({ folderId: folder.id, drafts });
      } catch (e) { res.status(500).json({ error: '上传失败: ' + e.message }); }
    });
  });

  function draftInput(user, body, previous) {
    const input = { ...(previous || {}) };
    for (const key of ['templateId', 'variables', 'images', 'topic', 'title', 'type', 'slots', 'staff', 'scheduledAt']) {
      if (Object.hasOwn(body, key)) input[key] = body[key];
    }
    const template = store.getTemplate(input.templateId);
    if (!template || template.userId !== user.id) throw jobInputError('模板不存在');
    const variables = input.variables === undefined ? {} : input.variables;
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw jobInputError('模板变量格式不正确');
    const images = input.images === undefined ? [] : input.images;
    if (!Array.isArray(images)) throw jobInputError('配图必须是数组');
    const limit = Math.max(0, Math.min(MAX_IMAGES, template.maxImages == null ? MAX_IMAGES : template.maxImages));
    if (images.length > limit) throw jobInputError(`图片数量超出限制（模板最多 ${limit} 张）`);
    const ownedImages = images.map((i) => {
      const img = i && store.listImages().find((x) => x.key === i.key);
      if (!img || img.userId !== user.id) throw jobInputError('包含不属于当前用户的图片');
      return { key: img.key, name: img.name || '', url: img.url || '' };
    });
    const staffChanged = Staff.hasStaff(body);
    const staff = staffChanged ? Staff.resolveStaff(body, store.listLibAccounts(), user.id)
      : Staff.hasStaff(input) ? Staff.readStaff(input, store.listLibAccounts()) : undefined;
    const text = !previous || Object.hasOwn(body, 'variables') || Object.hasOwn(body, 'templateId') || staffChanged
      ? renderBody(template, variables, staff).trim() : previous.text;
    if (!previous && (!text || !text.trim())) throw jobInputError('动态内容为空，请填写模板变量');
    let scheduledAt = input.scheduledAt;
    if (scheduledAt === null || scheduledAt === '') scheduledAt = '';
    else if (scheduledAt !== undefined) {
      if (typeof scheduledAt !== 'string' || !scheduledAt.trim() || !Number.isFinite(Date.parse(scheduledAt))) throw jobInputError('发布时间格式不正确');
      scheduledAt = new Date(scheduledAt).toISOString();
    }
    const title = String(input.title || '').trim();
    if (title.length > 20) throw jobInputError('动态标题最多 20 个字');
    return {
      templateId: template.id, templateName: template.name, variables: staff === undefined ? variables : Staff.variables(variables, staff),
      ...(staff !== undefined ? { staff } : {}),
      text, images: ownedImages, topic: input.topic || null, title,
      ...(scheduledAt !== undefined ? { scheduledAt } : {}),
      type: TASK_TYPES.includes(input.type) ? input.type : '原创',
      slots: Staff.staffView(input).slots,
      updatedAt: new Date().toISOString()
    };
  }

  function ownDraft(req, res) {
    const draft = store.getDraft(req.params.id);
    if (!draft || draft.userId !== req.user.id) {
      res.status(404).json({ error: '草稿不存在' });
      return null;
    }
    return draft;
  }

  router.get('/drafts', requireAuth, (req, res) => {
    const drafts = store.listDrafts().filter((d) => d.userId === req.user.id)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    res.json({ drafts: drafts.map(draftView) });
  });
  router.post('/drafts', requireAuth, async (req, res, next) => {
    try {
      const fields = draftInput(req.user, req.body || {});
      const draft = await store.addDraft({ id: genId('draft'), userId: req.user.id, ...fields, createdAt: fields.updatedAt });
      res.json({ draft: draftView(draft) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });
  router.patch('/drafts/:id', requireAuth, async (req, res, next) => {
    const original = ownDraft(req, res);
    if (!original) return;
    try {
      // 先在独立对象上完成全部校验，失败不改动原记录。
      const patch = draftInput(req.user, req.body || {}, original);
      res.json({ draft: draftView(await store.updateDraft(original.id, patch)) });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });
  router.delete('/drafts/:id', requireAuth, async (req, res, next) => {
    const draft = ownDraft(req, res);
    if (!draft) return;
    try {
      await store.deleteDraft(draft.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });
  router.post('/drafts/:id/publish', requireAuth, async (req, res, next) => {
    const draft = ownDraft(req, res);
    if (!draft) return;
    if (draftView(draft).incomplete) return res.status(400).json({ error: '草稿尚未完善：请填写正文和发布时间' });
    try {
      const account = store.listAccounts().find((item) => item.userId === req.user.id);
      if (!account) throw jobInputError('请先在账号管理添加 B 站账号');
      let when = new Date(draft.scheduledAt);
      if (!Number.isFinite(when.getTime())) throw jobInputError('计划时间格式不正确');
      if (when.getTime() < Date.now()) when = new Date();
      if (!draft.text || !draft.text.trim()) throw jobInputError('正文不能为空');
      const slotsR = resolveSlots(draft, draft.type, req.user.id);
      if (slotsR.error) throw jobInputError(slotsR.error);
      // 上传允许仅按名称保存话题；未命中时保留名称，不阻止草稿入队。
      let topic = draft.topic || null;
      if (topic && topic.name && !topic.id) {
        const found = await bili.searchTopic({ sessdata: account.sessdata, keywords: topic.name });
        const hit = found.find((item) => item.name === topic.name) || found[0];
        if (hit) topic = { id: hit.id, name: topic.name };
      }
      const now = new Date().toISOString();
      const job = {
        id: genId('job'), userId: req.user.id,
        templateId: draft.templateId, templateName: draft.templateName,
        accountId: account.id, accountName: account.uname || account.name,
        text: draft.text, images: draft.images, topic, title: draft.title,
        type: draft.type, slots: slotsR.slots, staff: Staff.readStaff(draft, store.listLibAccounts()), variables: draft.variables || {},
        mentions: mergeLibraryMentions(draft.text, store.listLibAccounts(), draft.mentions || [], req.user.id),
        scheduledAt: when.toISOString(), status: 'pending', attempts: 0,
        lastError: null, publishedAt: null, dynamicId: '', dynamicUrl: '',
        createdAt: now, updatedAt: now
      };
      await store.addJob(job);
      await store.deleteDraft(draft.id);
      res.json({ job });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      next(e);
    }
  });

  // 静默更新近期话题（批量用，不触发 save）
  function pushRecentTopicSilent(userId, topic) {
    if (!topic || !topic.id || !topic.name) return;
    const u = store.getUser(userId);
    if (!u) return;
    const list = (u.recentTopics || []).filter((t) => t.id !== topic.id);
    list.unshift({ id: topic.id, name: topic.name });
    u.recentTopics = list.slice(0, 8);
    // 不调用 store.save()
  }

  router.post('/jobs', requireAuth, async (req, res, next) => {
    try {
      const job = await createJobFromInput(req.user, req.body, { deferred: false, batch: false });
      res.json({ job });
    } catch (e) {
      if (e.status) {
        return res.status(e.status).json({ error: e.message });
      }
      next(e);
    }
  });

  // ===================== 批量入队 =====================
  router.post('/jobs/batch', requireAuth, async (req, res, next) => {
    try {
      const { items } = req.body || {};
      if (!Array.isArray(items)) {
        return res.status(400).json({ error: 'items 必须是数组' });
      }
      if (items.length > 50) {
        return res.status(400).json({ error: '单次最多入队 50 条' });
      }

      const created = [];
      const failed = [];

      for (let index = 0; index < items.length; index++) {
        try {
          const job = await createJobFromInput(req.user, items[index], { deferred: true, batch: true });
          created.push({ index, id: job.id, scheduledAt: job.scheduledAt, title: job.title });
        } catch (e) {
          failed.push({ index, error: e.message || '创建任务失败' });
        }
      }

      // 批量入队路径仅此一次 save
      store.save();

      res.json({ created, failed });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 批量草稿 =====================
  const MAX_DRAFT_ROWS = 50;
  const MAX_STR_LEN = { title: 20, url: 500, credit: 2000, body: 2000, varValue: 2000 };
  const DRAFT_VALID_STATUS = ['ready', 'parsing', 'parse_failed', 'enqueue_failed'];

  const draftImageKey = value => typeof value === 'string' ? value : value && typeof value.key === 'string' ? value.key : null;

  function validateDraftRow(req, row) {
    if (!row || typeof row !== 'object') return '行格式不正确';
    if (!row.id || typeof row.id !== 'string' || !row.id.trim()) return '行 id 不能为空';
    if (!DRAFT_VALID_STATUS.includes(row.status)) return `行 status 不合法: ${row.status}`;
    if (row.scheduledAt && (typeof row.scheduledAt !== 'string' || isNaN(new Date(row.scheduledAt).getTime()))) return `行 scheduledAt 格式不正确`;
    if (row.url && (typeof row.url !== 'string' || row.url.length > MAX_STR_LEN.url)) return `行 url 长度超限`;
    if (row.title && (typeof row.title !== 'string' || row.title.length > MAX_STR_LEN.title)) return `行 title 长度超限`;
    if (row.credit && (typeof row.credit !== 'string' || row.credit.length > MAX_STR_LEN.credit)) return `行 credit 长度超限`;
    if (row.body && (typeof row.body !== 'string' || row.body.length > MAX_STR_LEN.body)) return `行 body 长度超限`;
    if (!Array.isArray(row.images)) return '行 images 必须是数组';
    if (row.images.length > MAX_IMPORT_IMAGES) return '行 images 数量超限';
    for (const image of row.images) {
      const key = draftImageKey(image);
      if (!key) return 'images 必须包含有效图片 key';
      const img = store.listImages().find(i => i.key === key);
      if (!img || img.userId !== req.user.id) return '行包含不属于当前用户的图片';
    }
    if (!Array.isArray(row.selectedImages)) return '行 selectedImages 必须是数组';
    if (row.selectedImages.length > MAX_IMAGES) return '行 selectedImages 数量超限';
    const imageKeys = row.images.map(draftImageKey);
    for (const image of row.selectedImages) {
      if (!imageKeys.includes(draftImageKey(image))) return 'selectedImages 必须是 images 的子集';
    }
    if (row.config) {
      const { accountId, templateId } = row.config;
      if (accountId) {
        const acc = store.getAccount(accountId);
        if (!acc || acc.userId !== req.user.id) return 'config.accountId 不属于当前用户';
      }
      if (templateId) {
        const tpl = store.getTemplate(templateId);
        if (!tpl || tpl.userId !== req.user.id) return 'config.templateId 不属于当前用户';
      }
    }
    if (row.variables !== undefined) {
      if (!row.variables || typeof row.variables !== 'object' || Array.isArray(row.variables)) return 'variables 必须是对象';
      for (const val of Object.values(row.variables)) {
        if (val !== null && !['string', 'number', 'boolean'].includes(typeof val)) return 'variables 值必须是文本或数字';
        if (String(val ?? '').length > MAX_STR_LEN.varValue) return 'variables 值长度超限';
      }
    }
    try {
      if (Staff.hasStaff(row)) Staff.resolveStaff(row, store.listLibAccounts(), req.user.id);
      if (Staff.hasStaff(row.config)) Staff.resolveStaff(row.config, store.listLibAccounts(), req.user.id);
    } catch (error) { return error.message; }
    return null;
  }

  function sanitizeStaffRecord(record, userId) {
    const result = { ...(record || {}) };
    if (Staff.hasStaff(result)) result.staff = Staff.resolveStaff(result, store.listLibAccounts(), userId);
    delete result.people;
    if (result.slots) result.slots = Staff.staffView(result).slots;
    return result;
  }
  function sanitizeDraftRow(row, userId) {
    return {
      id: row.id, url: row.url || '', status: row.status, config: sanitizeStaffRecord(row.config, userId),
      ...(Staff.hasStaff(row) ? { staff: Staff.resolveStaff(row, store.listLibAccounts(), userId) } : {}),
      scheduledAt: row.scheduledAt || '', title: row.title || '',
      manualTitle: Boolean(row.manualTitle), manualTime: row.manualTime || null,
      images: (row.images || []).map(draftImageKey), selectedImages: (row.selectedImages || []).map(draftImageKey),
      credit: row.credit || '', body: row.body || '', variables: row.variables || {},
      topic: row.topic || null, error: row.error || '', createdAt: row.createdAt || new Date().toISOString()
    };
  }

  router.get('/batch-draft', requireAuth, (req, res) => {
    const draft = store.getBatchDraft(req.user.id);
    if (!draft) return res.json({ revision: 0, rows: [], config: {} });
    const view = record => Staff.hasStaff(record) ? { ...record, staff: Staff.readStaff({ ...record, userId: req.user.id }, store.listLibAccounts()) } : record;
    res.json({ revision: draft.revision, rows: draft.rows.map(row => ({ ...view(row), config: view(row.config) })), config: view(draft.config) });
  });

  router.put('/batch-draft', requireAuth, async (req, res, next) => {
    try {
      const current = store.getBatchDraft(req.user.id);
      const expectedRev = req.body && typeof req.body.revision === 'number' ? req.body.revision : -1;
      if (current && current.revision !== expectedRev) {
        return res.status(409).json({ error: '草稿已在别处更新', revision: current.revision });
      }
      const { rows, config } = req.body || {};
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows 必须是数组' });
      if (rows.length > MAX_DRAFT_ROWS) return res.status(400).json({ error: `最多保存 ${MAX_DRAFT_ROWS} 行` });
      const ids = new Set();
      for (const row of rows) {
        const err = validateDraftRow(req, row);
        if (err) return res.status(400).json({ error: err });
        if (ids.has(row.id)) return res.status(400).json({ error: `行 id 重复: ${row.id}` });
        ids.add(row.id);
      }
      const sanitized = rows.map(row => sanitizeDraftRow(row, req.user.id));
      const saved = await store.saveBatchDraft(req.user.id, sanitized, sanitizeStaffRecord(config, req.user.id));
      res.json({ revision: saved.revision, rows: saved.rows, config: saved.config });
    } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
  });

  router.post('/batch-draft/enqueue', requireAuth, async (req, res, next) => {
    try {
      const { revision: expectedRev, rowIds } = req.body || {};
      if (!Array.isArray(rowIds) || !rowIds.length) return res.status(400).json({ error: '未选择要入队的行' });
      const draft = store.getBatchDraft(req.user.id);
      if (!draft) return res.status(404).json({ error: '草稿不存在' });
      if (typeof expectedRev === 'number' && draft.revision !== expectedRev) {
        return res.status(409).json({ error: '草稿已在别处更新', revision: draft.revision });
      }
      const rowMap = new Map(draft.rows.map(r => [r.id, r]));
      const created = [];
      const failed = [];
      const existingJobs = store.listJobs().filter(j => j.userId === req.user.id && j.sourceDraftId);
      const sourceDraftIds = new Set(existingJobs.map(j => j.sourceDraftId));
      for (const rowId of rowIds) {
        const row = rowMap.get(rowId);
        if (!row) { failed.push({ rowId, error: '行不存在' }); continue; }
        if (row.status !== 'ready' && row.status !== 'enqueue_failed') {
          failed.push({ rowId, error: '该行尚未就绪' });
          continue;
        }
        if (!row.scheduledAt || !Number.isFinite(new Date(row.scheduledAt).getTime())) {
          failed.push({ rowId, error: '该行没有有效的计划时间' });
          continue;
        }
        if (sourceDraftIds.has(row.id)) {
          const existingJob = existingJobs.find(j => j.sourceDraftId === row.id);
          created.push({ rowId, id: existingJob.id });
          continue;
        }
        try {
          const rowError = validateDraftRow(req, row);
          if (rowError) { failed.push({ rowId, error: rowError }); continue; }
          const normalized = sanitizeDraftRow(row, req.user.id);
          const cfg = row.config || {};
          const tpl = store.getTemplate(cfg.templateId);
          const acc = store.getAccount(cfg.accountId);
          if (!tpl || tpl.userId !== req.user.id) { failed.push({ rowId, error: '模板不存在' }); continue; }
          if (!acc || acc.userId !== req.user.id) { failed.push({ rowId, error: '账号不存在' }); continue; }
          const mainVar = (tpl.variables || []).find(v => v.type === 'textarea');
          if (tpl.category !== 'batch' && !mainVar) { failed.push({ rowId, error: '模板无可写入正文的变量' }); continue; }
          const staff = Staff.hasStaff(row) ? Staff.resolveStaff(row, store.listLibAccounts(), req.user.id)
            : Staff.hasStaff(cfg) ? Staff.resolveStaff(cfg, store.listLibAccounts(), req.user.id) : undefined;
          const variables = tpl.category === 'batch'
            ? { ...row.variables, sourceUrl: row.variables?.sourceUrl || row.url || '', title: row.title || '', body: row.body || '', credit: row.credit || renderTemplate(tpl.signatureFormat || '', { ...row.variables, sourceUrl: row.url || '' }, staff) }
            : { ...row.variables, [mainVar.key]: row.body || row.credit };
          const images = normalized.selectedImages.map(key => {
            const img = store.listImages().find(i => i.key === key);
            return { key, name: img?.name || '', url: img?.url || '' };
          });
          const jobInput = {
            templateId: cfg.templateId, accountId: cfg.accountId,
            ...(staff !== undefined ? { staff } : {}),
            variables,
            images, title: row.title, topic: row.topic, mentions: [], type: '原创', scheduledAt: row.scheduledAt
          };
          const job = await createJobFromInput(req.user, jobInput, { deferred: true, batch: true });
          job.sourceDraftId = row.id;
          sourceDraftIds.add(row.id);
          existingJobs.push(job);
          created.push({ rowId, id: job.id });
        } catch (e) {
          failed.push({ rowId, error: e.message || '创建任务失败' });
        }
      }
      const successIds = new Set(created.map(c => c.rowId));
      const remainingRows = draft.rows.filter(r => !successIds.has(r.id));
      const updated = await store.saveBatchDraft(req.user.id, remainingRows, draft.config);
      await store.flushNow();
      res.json({ revision: updated.revision, rows: updated.rows, created, failed });
    } catch (e) { next(e); }
  });

  router.put('/jobs/:id', requireAuth, async (req, res, next) => {
    try {
      const job = store.getJob(req.params.id);
      if (!job || !canTouch(job, req)) return res.status(404).json({ error: '任务不存在' });
      if (job.status === 'publishing') return res.status(400).json({ error: '任务正在发布，无法编辑' });
      if (job.status === 'published') return res.status(400).json({ error: '任务已发布，无法编辑' });

      const { text, images, scheduledAt, accountId } = req.body || {};
      const patch = {};
      if (text !== undefined) {
        if (!String(text).trim()) return res.status(400).json({ error: '内容不能为空' });
        patch.text = String(text).trim();
      }
      if (accountId !== undefined) {
        const acc = store.getAccount(accountId);
        if (!acc || acc.userId !== job.userId) {
          return res.status(400).json({ error: 'B站账号不存在或不属于该用户' });
        }
        patch.accountId = acc.id;
        patch.accountName = acc.uname || acc.name;
      }
      if (images !== undefined) {
        patch.images = images.map((i) => ({ key: i.key, name: i.name || '', url: i.url || '' }));
      }
      if (scheduledAt !== undefined) {
        const when = new Date(scheduledAt);
        if (isNaN(when.getTime())) return res.status(400).json({ error: '时间格式不正确' });
        patch.scheduledAt = when.toISOString();
      }
      if (req.body.topic !== undefined) {
        const accId = patch.accountId || job.accountId;
        const acc = store.getAccount(accId);
        if (!acc) return res.status(400).json({ error: 'B站账号不存在' });
        try {
          patch.topic = await resolveTopic({ id: job.userId }, acc, req.body.topic);
        } catch (e) {
          return res.status(e.status || 500).json({ error: e.message });
        }
        if (patch.topic) pushRecentTopic(job.userId, patch.topic);
      }
      if (req.body.title !== undefined) {
        const t = String(req.body.title || '').trim();
        if (t.length > 20) return res.status(400).json({ error: '动态标题最多 20 个字' });
        patch.title = t;
      }
      if (req.body.mentions !== undefined) {
        const accId = patch.accountId || job.accountId;
        const acc = store.getAccount(accId);
        if (!acc) return res.status(400).json({ error: 'B站账号不存在' });
        try {
          patch.mentions = await resolveMentions({ id: job.userId }, acc, req.body.mentions);
        } catch (e) {
          return res.status(e.status || 500).json({ error: e.message });
        }
      }
      if (req.body.type !== undefined || req.body.slots !== undefined) {
        const newType = req.body.type !== undefined ? req.body.type : (job.type || '原创');
        if (!TASK_TYPES.includes(newType)) return res.status(400).json({ error: '内容类型不正确' });
        const s = resolveSlots(req.body, newType, job.userId);
        if (s.error) return res.status(400).json({ error: s.error });
        patch.type = newType;
        patch.slots = s.slots;
      }
      if (Staff.hasStaff(req.body)) {
        try { patch.staff = Staff.resolveStaff(req.body, store.listLibAccounts(), job.userId); }
        catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
        patch.slots = Staff.staffView({ slots: patch.slots || job.slots }).slots;
        const template = store.getTemplate(job.templateId);
        if (job.variables && template) {
          patch.variables = Staff.variables(job.variables, patch.staff);
          if (text === undefined) patch.text = renderBody(template, patch.variables, patch.staff).trim();
          if (!patch.text && text === undefined) return res.status(400).json({ error: '内容不能为空' });
        }
      }
      // 正文 @到账号库成员时自动登记为提及，修复「编辑后 @ 失效」（老数据保存一次即被修复）
      patch.mentions = mergeLibraryMentions(
        patch.text !== undefined ? patch.text : job.text,
        store.listLibAccounts(),
        patch.mentions !== undefined ? patch.mentions : (job.mentions || []),
        job.userId
      );
      patch.status = 'pending';
      patch.lastError = null;
      await store.updateJob(job.id, patch);
      await store.addLog('info', `任务 ${job.id} 已更新并重新排队`,
        { jobId: job.id, userId: job.userId });
      res.json({ job: store.getJob(job.id) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/jobs/:id/cancel', requireAuth, async (req, res, next) => {
    try {
      const job = store.getJob(req.params.id);
      if (!job || !canTouch(job, req)) return res.status(404).json({ error: '任务不存在' });
      if (job.status === 'published') return res.status(400).json({ error: '任务已发布，无法取消' });
      if (job.status === 'publishing') return res.status(400).json({ error: '任务正在发布，无法取消' });
      await store.updateJob(job.id, { status: 'canceled' });
      await store.addLog('info', `任务 ${job.id} 已取消`, { jobId: job.id, userId: job.userId });
      res.json({ job: store.getJob(job.id) });
    } catch (e) {
      next(e);
    }
  });

  router.post('/jobs/:id/publish-now', requireAuth, async (req, res, next) => {
    try {
      const job = store.getJob(req.params.id);
      if (!job || !canTouch(job, req)) return res.status(404).json({ error: '任务不存在' });
      await scheduler.publishNow(job.id);
      await store.addLog('info', `任务 ${job.id} 被手动触发立即发布`,
        { jobId: job.id, userId: job.userId });
      res.json({ job: store.getJob(job.id) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/jobs/:id/retry', requireAuth, async (req, res, next) => {
    try {
      const job = store.getJob(req.params.id);
      if (!job || !canTouch(job, req)) return res.status(404).json({ error: '任务不存在' });
      if (job.status === 'publishing') return res.status(400).json({ error: '任务正在发布' });
      if (job.status === 'published') return res.status(400).json({ error: '任务已发布' });
      await store.updateJob(job.id, {
        status: 'pending',
        scheduledAt: new Date().toISOString(),
        lastError: null
      });
      await store.addLog('info', `任务 ${job.id} 手动重试`, { jobId: job.id, userId: job.userId });
      res.json({ job: store.getJob(job.id) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/jobs/:id', requireAuth, async (req, res, next) => {
    try {
      const job = store.getJob(req.params.id);
      if (!job || !canTouch(job, req)) return res.status(404).json({ error: '任务不存在' });
      if (job.status === 'publishing') return res.status(400).json({ error: '任务正在发布，无法删除' });
      await store.deleteJob(job.id);
      await store.addLog('info', `任务 ${job.id} 已删除`, { jobId: job.id, userId: job.userId });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 发布队列导出 / 导入（zip + queue.csv） =====================
  const zipUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 100 * 1024 * 1024, files: 1 }
  });
  const IMG_EXT_SET = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']);
  // CSV 行数/大小限额
  const IMPORT_CSV_MAX_BYTES = 5 * 1024 * 1024;
  const IMPORT_CSV_MAX_ROWS = 1000;
  const IMPORT_IMG_MAX_BYTES = 20 * 1024 * 1024;
  // 每用户一把内存锁：同一时刻只允许一个导入
  const importLocks = new Set();

  /** 库内/包内文件名去重：不区分大小写，重名加 (2)、(3)…，同 key 复用同一名字 */
  function allocZipNames(images, jobs) {
    const used = new Map(); // name(lower) -> name
    const keyToName = new Map();
    for (const job of jobs) {
      for (const img of job.images || []) {
        if (keyToName.has(img.key)) continue;
        let name = sanitizeZipName(img.name || img.key);
        const lower = name.toLowerCase();
        if (used.has(lower)) {
          const dot = name.lastIndexOf('.');
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const ext = dot > 0 ? name.slice(dot) : '';
          let n = 2;
          let cand;
          do { cand = `${stem}(${n})${ext}`; n++; } while (used.has(cand.toLowerCase()));
          name = cand;
        }
        used.set(name.toLowerCase(), name);
        keyToName.set(img.key, name);
      }
    }
    return keyToName;
  }

  // POST /api/jobs/export：多选任务导出 zip（queue.csv + images/ + README.txt）
  router.post('/jobs/export', requireAuth, async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
      if (!ids.length) return res.status(400).json({ error: '未选择任务' });
      const adminAll = req.user.role === 'admin' && req.query.scope === 'all';
      const jobs = [];
      for (const id of ids) {
        const job = store.getJob(id);
        // 本人任务；管理员 ?scope=all 可导出他人任务
        if (!job || (job.userId !== req.user.id && !adminAll)) {
          return res.status(404).json({ error: `任务 ${id} 不存在` });
        }
        jobs.push(job);
      }
      // 全包预检：任何一张图片缺失或归属不符 → 422，不生成残缺 zip
      const keyToName = allocZipNames([], jobs);
      const imageReads = new Map(); // 仅本次请求复用读取结果，归属仍逐任务校验。
      for (const job of jobs) {
        for (const img of job.images || []) {
          const rec = store.listImages().find((i) => i.key === img.key);
          if (!rec) {
            return res.status(422).json({ error: `任务「${job.title || job.id}」的图片 ${img.key} 已丢失，无法导出` });
          }
          if (rec.userId !== job.userId) {
            return res.status(422).json({ error: `任务「${job.title || job.id}」的图片 ${img.key} 归属与任务所有者不符，无法导出` });
          }
          try {
            if (!imageReads.has(img.key)) imageReads.set(img.key, await storage.get(img.key));
          } catch (e) {
            return res.status(422).json({ error: `任务「${job.title || job.id}」的图片 ${img.key} 读取失败，无法导出` });
          }
        }
      }
      // 生成 CSV 行（超长单元格 → 422 说明）
      let csvText;
      try {
        csvText = buildQueueCsv(jobs.map((job) => {
          const names = (job.images || []).map((i) => keyToName.get(i.key));
          return jobToCsvCells(job, names);
        }));
      } catch (e) {
        return res.status(422).json({ error: e.message });
      }
      const csvBuf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(csvText, 'utf8')]);
      const readMe = Buffer.from([
        '380nm 发布队列导出包', '',
        '- queue.csv：任务清单（UTF-8 带 BOM，可直接用 Excel 打开）。',
        '- images/：所有任务配图，queue.csv「配图」列按文件名引用。',
        '- 计划时间列格式为 iso:<RFC3339 带时区偏移>，也接受 YYYY-MM-DD HH:mm（按 +08:00）。',
        '- 以 = + - @ 开头的单元格在导出时前置了一个单引号，导入时会自动剥掉。',
        '- 本包可通过「导入 zip」原样导回。'
      ].join('\r\n'), 'utf8');
      const entries = [{ name: 'queue.csv', buffer: csvBuf }, { name: 'README.txt', buffer: readMe }];
      for (const job of jobs) {
        for (const img of job.images || []) {
          const name = keyToName.get(img.key);
          if (entries.some((e) => e.name === 'images/' + name)) continue;
          const got = imageReads.get(img.key);
          entries.push({ name: 'images/' + name, buffer: got.buffer, mtime: new Date(img.createdAt || Date.now()) });
        }
      }
      const zip = buildZip(entries);
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const ts = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', `attachment; filename="380nm-queue-${ts}.zip"`);
      res.send(zip);
    } catch (e) {
      next(e);
    }
  });

  // GET /api/jobs/import-template：下载导入模板 zip
  router.get('/jobs/import-template', requireAuth, (req, res) => {
    const selectedTemplate = req.query.templateId ? store.listTemplates().find(t => t.id === req.query.templateId && t.userId === req.user.id) : null;
    if (req.query.templateId && !selectedTemplate) return res.status(404).json({ error: '模板不存在或无权访问' });
    // 固定按 +08:00 计算明天，避免依赖服务器时区或下载后立即过期。
    const tomorrow = new Date(Date.now() + 8 * 3600000);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const sampleTime = `${tomorrow.toISOString().slice(0, 10)}T10:00:00+08:00`;
    const sample = jobToCsvCells({
      title: '示例标题', scheduledAt: sampleTime,
      type: '原创', accountName: '账号名（需与账号库中名称一致）',
      templateName: '模板名（需与已有模板名称一致）',
      text: '这里是正文，可包含换行、逗号与引号。',
      topic: null, mentions: []
    }, ['示例图片.jpg']);
    sample[1] = `iso:${sampleTime}`; // 模板示例始终输出完整 +08:00 偏移。
    const columns = selectedTemplate ? templateColumns(selectedTemplate) : [];
    const fixedColumns = [{ key: 'title', label: '标题' }, { key: 'origAuthor', label: '原作者' }, { key: 'handle', label: 'X号' }].filter(v => !columns.some(c => c.key === v.key));
    const headers = selectedTemplate ? ['模板', ...columns.map(v => v.label), ...fixedColumns.map(v => v.label), '计划时间', '配图', '提及'] : [...CSV_HEADERS, '原作者', 'X号'];
    const selectedSample = selectedTemplate ? [selectedTemplate.name, ...columns.map(v => v.key === 'staff' ? '' : v.default ?? v.placeholder ?? ''), ...fixedColumns.map(v => v.key === 'title' ? '示例标题' : ''), `iso:${sampleTime}`, '["示例图片.jpg"]', '[]'] : [...sample, '', ''];
    // Different bodies can use exactly the same columns. Disambiguate only those
    // collisions, preserving the ordinary variable-only format for other templates.
    if (selectedTemplate) {
      const definition = t => JSON.stringify([t.content || '', t.signatureFormat || '', t.variables || []]);
      const labels = JSON.stringify(columns.map(v => v.label));
      const collision = store.listTemplates().some(t => t.userId === req.user.id && t.id !== selectedTemplate.id &&
        definition(t) !== definition(selectedTemplate) && JSON.stringify(templateColumns(t).map(v => v.label)) === labels);
      if (collision) {
        headers.push(`模板标识:${selectedTemplate.id}`);
        selectedSample.push(selectedTemplate.name);
      }
    }
    const csvText = [
      csvRow(headers),
      csvRow(['# 说明行：以 # 开头的行会被忽略。请勿修改表头。']),
      csvRow(['# 计划时间：iso:2026-11-05T14:00:00+08:00 或 2026-11-05 14:00（按 +08:00 解释，过去时间会导致该行失败）。']),
      csvRow(['# 账号/模板列填写名称，按 NFKC + 去空格 + 忽略大小写唯一匹配，匹配不到或多于一个则该行失败。']),
      csvRow(['# 话题列填 {"id":"...","name":"..."} 或留空；配图列为 JSON 文件名数组；提及列为 JSON 数组（可空 []）。']),
      csvRow(['# 图片放在 images/ 目录下（不支持子目录），扩展名仅支持 jpg/jpeg/png/gif/webp/bmp/avif。']),
      csvRow(['# 限制：zip ≤100MiB，条目 ≤2000，单图 ≤20MiB，解压总量 ≤200MiB，queue.csv ≤5MiB 且 ≤1000 行。']),
      csvRow(selectedSample)
    ].join('');
    const csvBuf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(csvText, 'utf8')]);
    const readMe = Buffer.from([
      '380nm 发布队列导入模板', '',
      '- 列顺序：' + headers.join(','),
      '- 作者说明与原作者独立填写；参与人员填写账号库名称，按顺序用英文分号 ; 分隔，名称必须唯一匹配。',
      '- 变量表头可使用模板变量 label 或 key；无账号列时使用当前用户首个账号。',
      '- 标题、原作者、X号均可留空；标题最多 20 字，X号导入时自动去掉前导 @。',
      '- 时间格式：iso:2026-11-05T14:00:00+08:00 或 2026-11-05 14:00（按 +08:00 解释）；过去时间该行失败。',
      '- 类型：原创 / 翻嵌 / 翻译 / 转载；账号、模板按名称唯一匹配（NFKC + 忽略大小写）。',
      '- 配图：JSON 数组按 images/ 内文件名引用，保持顺序；数量不得超过模板上限。',
      '- 图片放置规则：zip 根目录 queue.csv + images/ 一层目录；不支持子目录。',
      '- 限制：zip ≤100MiB、条目 ≤2000、单图 ≤20MiB、解压总量 ≤200MiB、CSV ≤5MiB 且 ≤1000 行。'
    ].join('\r\n'), 'utf8');
    const zip = buildZip([
      { name: 'queue.csv', buffer: csvBuf },
      { name: 'README.txt', buffer: readMe },
      { name: 'images/', buffer: Buffer.alloc(0) } // 目录占位条目
    ]);
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', 'attachment; filename="380nm-queue-import-template.zip"');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.send(zip);
  });

  // 名称匹配：NFKC + trim + 大小写不敏感唯一匹配
  function matchByName(list, name, label) {
    const key = String(name || '').normalize('NFKC').trim().toLowerCase();
    if (!key) return { error: `${label}不能为空`, hit: null };
    const hits = list.filter((x) => {
      const n = String(x.uname || x.name || '').normalize('NFKC').trim().toLowerCase();
      return n === key;
    });
    if (!hits.length) return { error: `未找到${label}「${name}」`, hit: null };
    if (hits.length > 1) return { error: `${label}「${name}」匹配到多个，名称存在歧义`, hit: null };
    return { hit: hits[0] };
  }

  // 导入用：只看指定用户的账号/模板
  const listMy = (list, uid) => list.filter((x) => x.userId === uid);

  // 两种导入共用整个 ZIP 安全预检、CSV 解析、文件夹和图片入库流程。
  // 草稿仅跳过账号/计划时间校验，正文均使用 CSV 原文。
  function importQueue(req, res, asDraft = false) {
    if (importLocks.has(req.user.id)) {
      return res.status(409).json({ error: '已有导入正在进行，请稍后再试' });
    }
    importLocks.add(req.user.id);
    zipUpload.single('file')(req, res, (uploadError) => {
      if (uploadError) {
        importLocks.delete(req.user.id);
        return res.status(400).json({ error: 'zip 上传失败，请检查文件大小和格式' });
      }
      (async () => {
        const created = [], skipped = [], failed = [];
        const folderName = `导入 ${new Date().toLocaleString('zh-CN', {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).replace(/\//g, '-')}`;
        let folder = null;
        try {
          const f = req.file;
          if (!f || !f.buffer || !f.buffer.length) {
            return res.status(400).json({ error: '缺少 zip 文件（字段名 file）' });
          }
          let entries;
          try {
            entries = unzip(f.buffer, {
              maxEntries: 2000,
              maxTotalBytes: 200 * 1024 * 1024,
              maxFileBytes: IMPORT_IMG_MAX_BYTES
            });
          } catch (e) {
            const msg = e && e.name === 'ZipError' ? e.message : 'zip 解析失败';
            return res.status(400).json({ error: msg });
          }

          // 结构预检：根 queue.csv（大小写兼容）+ images/ 一层；静默忽略目录与系统元数据
          let csvEntry = null, csvCount = 0, unexpected = null;
          const images = new Map(); // images/ 内文件名(原样) -> {name, buffer}
          for (const e of entries) {
            const clean = e.name.replace(/\/+$/, '');
            const segs = clean ? clean.split('/') : [];
            // unzip 已完成安全校验；目录占位、macOS 资源叉及隐藏路径不参与导入。
            if (e.isDir || segs[0] === '__MACOSX' || segs.some(s => s.startsWith('.'))) continue;
            if (segs.length === 1) {
              const rootName = segs[0].toLowerCase();
              if (rootName === 'queue.csv') { csvEntry = e; csvCount++; }
              else if (rootName === 'readme.txt' || rootName === 'thumbs.db' || rootName === 'desktop.ini') { /* 允许或忽略 */ }
              else { unexpected = e.name; break; }
            } else if (segs[0] === 'images' && segs.length === 2) {
              images.set(segs[1], { name: segs[1], buffer: e.buffer });
            } else { unexpected = e.name; break; }
          }
          if (unexpected) return res.status(400).json({ error: `不允许的条目: ${unexpected}（仅接受根 queue.csv、images/ 一层目录与 README.txt）` });
          if (!csvEntry || csvCount > 1) return res.status(400).json({ error: 'zip 根目录必须有且仅有一个 queue.csv' });
          if (csvEntry.buffer.length > IMPORT_CSV_MAX_BYTES) {
            return res.status(400).json({ error: 'queue.csv 超过 5MiB 上限' });
          }

          // 图片全包预检：扩展名白名单 + 魔数一致
          for (const [fname, img] of images) {
            const ext = path.extname(fname).toLowerCase().replace('.', '');
            if (!IMG_EXT_SET.has(ext)) {
              return res.status(400).json({ error: `images/${fname} 扩展名不在支持范围（jpg/jpeg/png/gif/webp/bmp/avif）` });
            }
            if (!imageExtMatchesMagic(ext, img.buffer)) {
              return res.status(400).json({ error: `images/${fname} 内容与扩展名不符（魔数校验失败）` });
            }
          }

          let rows;
          try {
            const csvText = csvEntry.buffer.toString('utf8');
            // 限制 CSV 行数
            const lineCount = csvText.split('\n').filter((l) => l.trim() !== '').length;
            if (lineCount > IMPORT_CSV_MAX_ROWS + 1) {
              return res.status(400).json({ error: `queue.csv 超过 ${IMPORT_CSV_MAX_ROWS} 行上限` });
            }
            rows = parseQueueCsv(csvText);
          } catch (e) {
            return res.status(400).json({ error: e.message });
          }

          // 本次导入新建一个文件夹（属主为导入者）
          folder = { id: genId('fld'), userId: req.user.id, name: folderName, createdAt: new Date().toISOString() };
          await store.addFolder(folder);

          // 库内同名图片加 (2)（按导入者图库，不区分大小写）
          const libNames = new Set(
            store.listImages().filter((i) => i.userId === req.user.id)
              .map((i) => String(i.name || '').toLowerCase())
          );
          const zipStored = new Map(); // zip 内条目名 -> 入库 meta（同条目只存一次）

          for (const r of rows) {
            if (r.skipped) { skipped.push({ row: r.row, reason: r.reason }); continue; }
            let rowNewKeys = []; // 本行新增入库的图片 key（行失败时回滚）
            let rowFailed = false;
            const fail = (reason) => {
              if (rowFailed) return Promise.resolve();
              rowFailed = true;
              failed.push({ row: r.row, reason });
              let chain = Promise.resolve();
              for (const k of rowNewKeys) {
                for (const [name, meta] of zipStored) {
                  if (meta.key === k) { zipStored.delete(name); libNames.delete(meta.name.toLowerCase()); }
                }
                chain = chain
                  .then(() => storage.delete(k)).catch(() => {})
                  .then(() => store.deleteImage(k));
              }
              rowNewKeys = [];
              return chain;
            };
            const rowFail = fail;
            try {
              // 标题 ≤20、正文非空、类型合法
              if (r.title.length > 20) { await rowFail('标题最多 20 个字'); }
              else if (!r.variableCells && !r.text.trim()) { await rowFail('正文不能为空'); }
              else if (!CSV_TYPE_SET.has(r.type)) { await rowFail(`类型必须为 原创/翻嵌/翻译/转载（当前: ${r.type || '空'}）`); }
              // 计划时间：过去时间 → 该行失败
              else if (!asDraft && !resolveCsvTime(r.scheduledAt)) { await rowFail('计划时间格式不正确（接受 iso:<带偏移> 或 YYYY-MM-DD HH:mm）'); }
              else if (!asDraft && resolveCsvTime(r.scheduledAt).getTime() <= Date.now()) { await rowFail('计划时间是过去时间'); }
              else {
                const when = resolveCsvTime(r.scheduledAt);
                const accM = asDraft ? { hit: null } : r.variableCells && !r.accountName ? { hit: listMy(store.listAccounts(), req.user.id)[0], error: '没有可用发布账号' } : matchByName(listMy(store.listAccounts(), req.user.id), r.accountName, '账号');
                const tplM = matchByName(listMy(store.listTemplates(), req.user.id), r.templateName, '模板');
                const account = accM.hit, template = tplM.hit;
                if (!asDraft && !account) { await rowFail(accM.error || '账号匹配失败'); continue; }
                if (!template) { await rowFail(tplM.error || '模板匹配失败'); continue; }
                const variables = {};
                const cells = r.csvCells;
                const fixedLabels = { title: '标题', origAuthor: '原作者', handle: 'X号' };
                const readVariable = v => cells[v.key] ?? cells[v.label] ?? cells[fixedLabels[v.key]] ?? '';
                const importColumns = templateColumns(template);
                const titleColumn = importColumns.find(v => v.key === 'title') || { key: 'title', label: '标题' };
                r.title = readVariable(titleColumn).trim();
                if (r.title.length > 20) { await rowFail('标题最多 20 个字'); continue; }
                for (const key of ['origAuthor', 'handle']) {
                  variables[key] = readVariable(importColumns.find(v => v.key === key) || { key, label: fixedLabels[key] });
                }
                let staff;
                if (r.variableCells) {
                  for (const v of templateColumns(template).filter(v => v.key !== 'staff')) {
                    variables[v.key] = readVariable(v);
                  }
                  if (Object.hasOwn(r.variableCells, '参与人员')) {
                    const names = r.variableCells['参与人员'].split(';').map(name => name.trim()).filter(Boolean);
                    const matches = names.map(name => matchByName(listMy(store.listLibAccounts(), req.user.id), name, '参与人员'));
                    const bad = matches.find(match => !match.hit);
                    if (bad) { await rowFail(bad.error); continue; }
                    if (new Set(matches.map(match => match.hit.id)).size !== matches.length) { await rowFail('参与人员不能重复'); continue; }
                    staff = Staff.resolveStaff({ staff: matches.map(match => match.hit.id) }, store.listLibAccounts(), req.user.id);
                  }
                  variables.handle = variables.handle.trim().replace(/^@+/, '');
                  r.text = renderBody(template, variables, staff);
                  if (!r.text.trim()) { await rowFail('正文不能为空'); continue; }
                }
                variables.handle = variables.handle.trim().replace(/^@+/, '');
                // 配图 JSON 数组（保序）
                let imgs;
                try { imgs = JSON.parse(r.images || '[]'); } catch (e) { imgs = null; }
                const limit = Math.max(0, Math.min(MAX_IMAGES, template.maxImages ?? MAX_IMAGES));
                let mentions;
                try { mentions = JSON.parse(r.mentions || '[]'); } catch (e) { mentions = null; }
                let topic = null;
                if (!rowFailed && r.topic) {
                  try {
                    const t = JSON.parse(r.topic);
                    if (t && t.name != null) topic = { id: t.id != null ? t.id : '', name: String(t.name) };
                    else await rowFail('话题列格式不正确');
                  } catch (e) { await rowFail('话题列不是合法 JSON'); }
                }
                if (!Array.isArray(imgs)) await rowFail('配图列必须是 JSON 数组');
                else if (imgs.length > limit) await rowFail(`图片数量超出限制（模板最多 ${limit} 张）`);
                else if (!Array.isArray(mentions)) await rowFail('提及列必须是 JSON 数组');
                if (!rowFailed) {
                  // 图片入库（同一 zip 内同条目只存一次）
                  const jobImages = [];
                  for (const fname of imgs) {
                    const ent = images.get(String(fname));
                    if (!ent) { await rowFail(`配图 ${fname} 不在 images/ 目录中`); break; }
                    let meta = zipStored.get(ent.name);
                    if (!meta) {
                      const kind = magicForImage(ent.buffer);
                      const { key, url } = await storage.put(ent.buffer, ent.name, contentTypeForMagic(kind));
                      // 库内同名加 (2)
                      let name = ent.name;
                      let low = name.toLowerCase();
                      if (libNames.has(low)) {
                        const dot = name.lastIndexOf('.');
                        const stem = dot > 0 ? name.slice(0, dot) : name;
                        const ext = dot > 0 ? name.slice(dot) : '';
                        let n = 2, cand;
                        do { cand = `${stem}(${n})${ext}`; n++; } while (libNames.has(cand.toLowerCase()));
                        name = cand; low = name.toLowerCase();
                      }
                      libNames.add(low);
                      meta = {
                        key, userId: req.user.id, folderId: folder.id, name,
                        url, size: ent.buffer.length,
                        contentType: contentTypeForMagic(kind),
                        createdAt: new Date().toISOString()
                      };
                      rowNewKeys.push(key);
                      await store.addImage(meta);
                      zipStored.set(ent.name, meta);
                    }
                    jobImages.push({ key: meta.key, name: meta.name, url: meta.url });
                  }
                  if (!rowFailed) {
                    // 任务直接落库：正文用 CSV 原文，不用模板重渲染
                    const job = {
                      id: genId(asDraft ? 'draft' : 'job'),
                      userId: req.user.id,
                      templateId: template.id,
                      templateName: template.name,
                      ...(!asDraft ? { accountId: account.id, accountName: account.uname || account.name } : { variables: {} }),
                      variables,
                      ...(staff ? { staff } : {}),
                      text: r.text,
                      images: jobImages,
                      topic,
                      title: r.title,
                      mentions,
                      type: r.type,
                      slots: {},
                      ...(!asDraft ? {
                        scheduledAt: when.toISOString(), status: 'pending', attempts: 0,
                        lastError: null, publishedAt: null, dynamicId: '', dynamicUrl: ''
                      } : {}),
                      createdAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString()
                    };
                    if (asDraft) await store.addDraft(job);
                    else store.addJobSilent(job);
                    created.push({ row: r.row, id: job.id });
                  }
                }
              }
            } catch (e) {
              console.error(`[jobs/import] 第 ${r.row} 行导入失败`, e);
              await fail(`导入失败（第 ${r.row} 行）`);
            }
          }
          store.save();
          if (created.length) {
            await store.addLog('info', `zip 导入：新建文件夹「${folderName}」，入队 ${created.length} 条任务（跳过 ${skipped.length}，失败 ${failed.length}）`, { userId: req.user.id });
          }
          res.json({ folderId: folder ? folder.id : null, created, skipped, failed });
        } catch (e) {
          console.error('[jobs/import] 导入失败', e);
          res.status(500).json({ error: '导入失败，请稍后重试' });
        } finally {
          importLocks.delete(req.user.id);
        }
      })().catch((e) => {
        importLocks.delete(req.user.id);
        console.error('[jobs/import] 导入处理失败', e);
        if (!res.headersSent) res.status(500).json({ error: '导入失败，请稍后重试' });
      });
    });
  }
  router.post('/jobs/import', requireAuth, (req, res) => importQueue(req, res));
  router.post('/drafts/import', requireAuth, (req, res) => importQueue(req, res, true));

  router.get('/logs', requireAuth, (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 100);
    const list = store.listLogs().filter(scopeFilter(req)).slice(0, limit);
    res.json({ logs: list });
  });

  // ===================== 存储用量（图库页顶部展示） =====================
  router.get('/storage/usage', requireAuth, async (req, res) => {
    try {
      const usage = await storage.usage();
      res.json({ usage });
    } catch (e) {
      res.json({ usage: null, error: e.message });
    }
  });

  return router;
};
