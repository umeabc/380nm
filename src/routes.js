const express = require('express');
const multer = require('multer');
const { genId, sanitizeUser } = require('./store');
const { renderTemplate } = require('./render');
const { PRESET_TAGS, TASK_TYPES, TYPE_SLOTS, SLOT_LABELS, slotSegment } = require('./templates');
const {
  hashPassword, verifyPassword, attachUser, requireAuth, requireAdmin
} = require('./auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 9 }
});

const { importFromUrl, parseWork, ImportError } = require('./importers');
const { buildZip } = require('./zip');
const { cookieErrorText } = require('./cookie-monitor');
const { mergeLibraryMentions } = require('./mentions');

const MAX_IMAGES = 9;
const MAX_IMPORT_IMAGES = 30;
const COOKIE = 'sid';

// 全站导入设置的机密字段
const SETTING_SECRETS = ['pixivSession', 'twitterAuth', 'twitterCt0'];

function maskSecret(s) {
  if (!s) return '';
  return s.length <= 12 ? s.slice(0, 4) + '****' : s.slice(0, 8) + '****' + s.slice(-4);
}

function maskAccount(a) {
  return { ...a, sessdata: maskSecret(a.sessdata), bili_jct: maskSecret(a.bili_jct) };
}

function validateTemplate(body) {
  const { name, content, variables = [], maxImages } = body || {};
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
      variables,
      maxImages: Math.max(0, Math.min(MAX_IMAGES, Number(maxImages) || MAX_IMAGES))
    }
  };
}

module.exports = function createRoutes(ctx) {
  const { store, storage, bili, scheduler } = ctx;
  const router = express.Router();

  router.use(attachUser(store));

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
      const user = store.getUserByUsername(username);
      if (!user || !verifyPassword(password, user.passwordHash)) {
        return res.status(401).json({ error: '用户名或密码错误' });
      }
      if (user.active === false) return res.status(403).json({ error: '该账号已被禁用，请联系管理员' });
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
  router.get('/accounts', requireAuth, (req, res) => {
    res.json({ accounts: store.listAccounts().filter(scopeFilter(req)).map(maskAccount) });
  });

  router.post('/accounts', requireAuth, async (req, res, next) => {
    try {
      const { name, sessdata, bili_jct } = req.body || {};
      if (!sessdata || !bili_jct) {
        return res.status(400).json({ error: 'SESSDATA 和 bili_jct 均为必填' });
      }
      let info;
      try {
        info = await bili.getMyInfo(String(sessdata).trim());
      } catch (e) {
        return res.status(502).json({ error: '校验失败（无法连接B站）: ' + e.message });
      }
      if (info.code !== 0) {
        return res.status(400).json({ error: `Cookie 无效 (code ${info.code}): ${info.message || ''}` });
      }
      const d = info.data || {};
      const account = {
        id: genId('acc'),
        userId: req.user.id,
        name: (name || '').trim() || d.uname || '未命名账号',
        uid: d.mid,
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

  router.post('/accounts/:id/reverify', requireAuth, async (req, res, next) => {
    try {
      const acc = store.getAccount(req.params.id);
      if (!acc || !canTouch(acc, req)) return res.status(404).json({ error: '账号不存在' });
      let info;
      try {
        info = await bili.getMyInfo(acc.sessdata);
      } catch (e) {
        return res.status(502).json({ error: '校验失败（无法连接B站）: ' + e.message });
      }
      const checkedAt = new Date().toISOString();
      if (info.code !== 0) {
        // 记录失败状态，账号一览会以红字展示具体报错
        await store.updateAccount(acc.id, {
          cookieStatus: { ok: false, code: Number(info.code) || null, message: cookieErrorText(info), checkedAt }
        });
        return res.status(400).json({ error: `Cookie 可能已失效 (code ${info.code}): ${info.message || ''}` });
      }
      const d = info.data || {};
      await store.updateAccount(acc.id, {
        uid: d.mid, uname: d.uname, avatar: d.face || '',
        cookieStatus: { ok: true, code: 0, message: '', checkedAt }
      });
      await store.addLog('info', `B站账号校验通过: ${d.uname}`, { userId: req.user.id });
      res.json({ account: maskAccount(store.getAccount(acc.id)) });
    } catch (e) {
      next(e);
    }
  });

  // 修改 Cookie：先向B站校验，通过才覆盖，避免写坏数据
  router.put('/accounts/:id/cookie', requireAuth, async (req, res, next) => {
    try {
      const acc = store.getAccount(req.params.id);
      if (!acc || !canTouch(acc, req)) return res.status(404).json({ error: '账号不存在' });
      const sessdata = String((req.body && req.body.sessdata) || '').trim();
      const biliJct = String((req.body && req.body.bili_jct) || '').trim();
      if (!sessdata || !biliJct) return res.status(400).json({ error: 'SESSDATA 和 bili_jct 均为必填' });

      let info;
      try {
        info = await bili.getMyInfo(sessdata);
      } catch (e) {
        return res.status(502).json({ error: '校验失败（无法连接B站）: ' + e.message });
      }
      const checkedAt = new Date().toISOString();
      if (info.code !== 0) {
        await store.updateAccount(acc.id, {
          cookieStatus: { ok: false, code: Number(info.code) || null, message: cookieErrorText(info), checkedAt }
        });
        return res.status(400).json({ error: `新 Cookie 无效 (code ${info.code}): ${info.message || ''}` });
      }

      const d = info.data || {};
      const patch = {
        sessdata,
        bili_jct: biliJct,
        uid: d.mid,
        uname: d.uname,
        avatar: d.face || '',
        cookieStatus: { ok: true, code: 0, message: '', checkedAt }
      };
      const name = String((req.body && req.body.name) || '').trim();
      if (name) patch.name = name;
      await store.updateAccount(acc.id, patch);
      await store.addLog('info', `B站账号「${d.uname}」Cookie 已更新并校验通过`, { userId: req.user.id });
      res.json({ account: maskAccount(store.getAccount(acc.id)) });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/accounts/:id', requireAuth, async (req, res, next) => {
    try {
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
      await store.addLog('info', `删除B站账号: ${acc.uname}`, { userId: req.user.id });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 模板（按用户隔离） =====================
  router.get('/templates', requireAuth, (req, res) => {
    res.json({ templates: store.listTemplates().filter(scopeFilter(req)) });
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
      const { error, tpl: body } = validateTemplate(req.body);
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

  // ===================== 作品解析（流式进度，PRD F-D1~F-D3） =====================
  const PARSE_ERRORS = {
    invalid: { t: '无法识别的链接', s: '仅支持 X(Twitter) 与 Pixiv 的作品页链接。示例：x.com/用户名/status/ID、pixiv.net/artworks/ID' },
    notfound: { t: '链接失效或不存在的作品', s: '该作品可能已被删除，或链接中的作品 ID 有误' },
    restricted: { t: '需要登录或为限制级作品', s: '该作品需要登录或为 R-18 内容，无法直接抓取。请手动保存图片后通过「上传图片」添加' },
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
      const { work, images } = await parseWork(url, store.getSettings(), onProgress);
      const capped = images.slice(0, MAX_IMPORT_IMAGES);
      const saved = [];
      for (const it of capped) {
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
      send({ type: 'done', step: 4, work, images: saved, total: images.length });
      res.end();
    } catch (e) {
      const code = (e && e.code && PARSE_ERRORS[e.code]) ? e.code : 'network';
      send({ type: 'error', step: Math.min(done, 3), error: code, message: PARSE_ERRORS[code].t });
      res.end();
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
        items = await importFromUrl(url, store.getSettings());
      } catch (e) {
        if (e instanceof ImportError) return res.status(400).json({ error: e.message });
        throw e;
      }
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: '未从该链接获取到图片' });
      }
      const capped = items.slice(0, MAX_IMPORT_IMAGES);
      const saved = [];
      for (const it of capped) {
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
        `链接导入 ${saved.length} 张图片${items.length > MAX_IMPORT_IMAGES ? `（超出上限，已截取前 ${MAX_IMPORT_IMAGES} 张）` : ''}: ${url.slice(0, 100)}`,
        { userId: req.user.id });
      res.json({ images: saved, total: items.length });
    } catch (e) {
      next(e);
    }
  });

  // ===================== 图片上传 / 图库（按用户隔离） =====================
  router.get('/images', requireAuth, (req, res) => {
    res.json({ images: store.listImages().filter(scopeFilter(req)) });
  });

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
        const saved = [];
        for (const f of files) {
          if (!f.mimetype || !f.mimetype.startsWith('image/')) continue;
          if (!f.buffer || !f.buffer.length) continue;
          const { key, url } = await storage.put(f.buffer, f.originalname, f.mimetype);
          const meta = {
            key,
            userId: req.user.id,
            folderId,
            name: f.originalname || key,
            url,
            size: f.size,
            contentType: f.mimetype,
            createdAt: new Date().toISOString()
          };
          await store.addImage(meta);
          saved.push(meta);
        }
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

  // ===================== 预设标签 / 内容类型 =====================
  router.get('/tags', requireAuth, (req, res) => {
    res.json({ tags: PRESET_TAGS, types: TASK_TYPES, typeSlots: TYPE_SLOTS, slotLabels: SLOT_LABELS });
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

  // ===================== 预设标签 / 内容类型（已挂载于 /tags） =====================

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

  // 标签校验（PRD F-Q1：预设集合，0~3 个）
  function validateTags(raw) {
    if (raw === undefined || raw === null) return { list: [] };
    if (!Array.isArray(raw)) return { error: '标签格式不正确' };
    const list = [];
    for (const t of raw) {
      const v = String(t || '').trim();
      if (!v) continue;
      if (!PRESET_TAGS.includes(v)) return { error: `标签「${v}」不在预设集合中` };
      if (!list.includes(v)) list.push(v);
    }
    if (list.length > 3) return { error: '最多绑定 3 个标签' };
    return { list };
  }

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
    res.json({ jobs: store.listJobs().filter(scopeFilter(req)) });
  });

  router.post('/jobs', requireAuth, async (req, res, next) => {
    try {
      const { templateId, accountId, variables = {}, images = [], scheduledAt } = req.body || {};
      const template = store.getTemplate(templateId);
      if (!template || template.userId !== req.user.id) {
        return res.status(400).json({ error: '模板不存在' });
      }
      const account = store.getAccount(accountId);
      if (!account || account.userId !== req.user.id) {
        return res.status(400).json({ error: '请选择要发布的B站账号' });
      }

      const text = renderTemplate(template.content, variables).trim();
      if (!text) return res.status(400).json({ error: '动态内容为空，请填写模板变量' });
      const limit = Math.max(0, Math.min(MAX_IMAGES, template.maxImages || MAX_IMAGES));
      if (images.length > limit) {
        return res.status(400).json({ error: `图片数量超出限制（模板最多 ${limit} 张）` });
      }
      for (const i of images) {
        const img = store.listImages().find((x) => x.key === i.key);
        if (!img || img.userId !== req.user.id) {
          return res.status(400).json({ error: '包含不属于当前用户的图片' });
        }
      }

      let when = scheduledAt ? new Date(scheduledAt) : new Date();
      if (isNaN(when.getTime())) return res.status(400).json({ error: '计划时间格式不正确' });
      if (when.getTime() < Date.now()) when = new Date(); // 已过时间按立即发布处理

      let topic = null;
      try {
        topic = await resolveTopic(req.user, account, req.body.topic);
      } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
      }

      let title = String((req.body && req.body.title) || '').trim();
      if (title.length > 20) return res.status(400).json({ error: '动态标题最多 20 个字' });

      let mentions = [];
      try {
        mentions = await resolveMentions(req.user, account, req.body.mentions);
      } catch (e) {
        return res.status(e.status || 500).json({ error: e.message });
      }
      // 正文里 @到账号库成员的，补登记为提及（模板变量/人员槽位渲染出的 @ 不会自己进 mentions）
      mentions = mergeLibraryMentions(text, store.listLibAccounts(), mentions, req.user.id);

      // 标签 / 内容类型 / 署名槽位（PRD F-Q1/Q5/Q6）
      const tags = validateTags(req.body.tags);
      if (tags.error) return res.status(400).json({ error: tags.error });
      const type = TASK_TYPES.includes(req.body.type) ? req.body.type : '原创';
      const slotsR = resolveSlots(req.body, type, req.user.id);
      if (slotsR.error) return res.status(400).json({ error: slotsR.error });

      const job = {
        id: genId('job'),
        userId: req.user.id,
        templateId: template.id,
        templateName: template.name,
        accountId: account.id,
        accountName: account.uname || account.name,
        text,
        images: images.map((i) => ({ key: i.key, name: i.name || '', url: i.url || '' })),
        topic,
        title,
        mentions,
        tags: tags.list,
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
      await store.addJob(job);
      if (topic) pushRecentTopic(req.user.id, topic);
      await store.addLog(
        'info',
        `任务加入队列: ${template.name} -> ${job.accountName}，计划 ${when.toLocaleString('zh-CN')}`,
        { jobId: job.id, userId: req.user.id }
      );
      res.json({ job });
    } catch (e) {
      next(e);
    }
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
      if (req.body.tags !== undefined) {
        const t = validateTags(req.body.tags);
        if (t.error) return res.status(400).json({ error: t.error });
        patch.tags = t.list;
      }
      if (req.body.type !== undefined || req.body.slots !== undefined) {
        const newType = req.body.type !== undefined ? req.body.type : (job.type || '原创');
        if (!TASK_TYPES.includes(newType)) return res.status(400).json({ error: '内容类型不正确' });
        const s = resolveSlots(req.body, newType, job.userId);
        if (s.error) return res.status(400).json({ error: s.error });
        patch.type = newType;
        patch.slots = s.slots;
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

  // ===================== 日志（按用户隔离） =====================
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
