const express = require('express');
const multer = require('multer');
const { genId, sanitizeUser } = require('./store');
const { renderTemplate } = require('./render');
const {
  hashPassword, verifyPassword, attachUser, requireAuth, requireAdmin
} = require('./auth');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 9 }
});

const MAX_IMAGES = 9;
const COOKIE = 'sid';

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
      if (info.code !== 0) {
        return res.status(400).json({ error: `Cookie 可能已失效 (code ${info.code}): ${info.message || ''}` });
      }
      const d = info.data || {};
      await store.updateAccount(acc.id, { uid: d.mid, uname: d.uname, avatar: d.face || '' });
      await store.addLog('info', `B站账号校验通过: ${d.uname}`, { userId: req.user.id });
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

  // ===================== 图片上传 / 图库（按用户隔离） =====================
  router.get('/images', requireAuth, (req, res) => {
    res.json({ images: store.listImages().filter(scopeFilter(req)) });
  });

  router.post('/upload', requireAuth, (req, res) => {
    upload.array('files', MAX_IMAGES)(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      try {
        const files = req.files || [];
        const saved = [];
        for (const f of files) {
          if (!f.mimetype || !f.mimetype.startsWith('image/')) continue;
          if (!f.buffer || !f.buffer.length) continue;
          const { key, url } = await storage.put(f.buffer, f.originalname, f.mimetype);
          const meta = {
            key,
            userId: req.user.id,
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

  return router;
};
