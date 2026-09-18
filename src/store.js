const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_TEMPLATES } = require('./templates');
const { hashPassword, newSessionToken, SESSION_TTL_MS } = require('./auth');

const genId = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

function sanitizeUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = {
      users: [], sessions: {}, folders: [],
      accounts: [], templates: [], jobs: [], logs: [], images: []
    };
    this._saveTimer = null;
  }

  async init() {
    try {
      const raw = (await fsp.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '');
      const parsed = JSON.parse(raw);
      this.data = { ...this.data, ...parsed };
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[store] 读取数据文件失败，将使用空数据:', e.message);
    }
    if (!Array.isArray(this.data.users)) this.data.users = [];
    if (!this.data.sessions || typeof this.data.sessions !== 'object') this.data.sessions = {};
    if (!Array.isArray(this.data.folders)) this.data.folders = [];
    if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
    if (!Array.isArray(this.data.templates)) this.data.templates = [];
    if (!Array.isArray(this.data.jobs)) this.data.jobs = [];
    if (!Array.isArray(this.data.logs)) this.data.logs = [];
    if (!Array.isArray(this.data.images)) this.data.images = [];

    this._migrate();
    await this._flush();
  }

  /** 旧版本单用户数据迁移：补 userId，建默认管理员，为其播种模板 */
  _migrate() {
    let admin = this.data.users.find((u) => u.role === 'admin' && u.active !== false);
    if (!this.data.users.length) {
      admin = {
        id: genId('usr'),
        username: 'admin',
        name: '管理员',
        role: 'admin',
        active: true,
        passwordHash: hashPassword('admin123'),
        createdAt: new Date().toISOString(),
        lastLoginAt: null
      };
      this.data.users.push(admin);
      console.warn('[store] 已创建默认管理员账号: admin / admin123 （请登录后尽快修改密码）');
      this.data.logs.unshift({
        time: new Date().toISOString(),
        level: 'info',
        message: '初始化完成，已创建默认管理员账号 admin（请尽快修改默认密码）',
        userId: admin.id
      });
    }
    if (!admin) admin = this.data.users[0];
    const own = (rec) => {
      if (!rec.userId) rec.userId = admin.id;
    };
    this.data.accounts.forEach(own);
    this.data.templates.forEach(own);
    this.data.jobs.forEach(own);
    this.data.images.forEach(own);
    this.data.logs.forEach(own);
    if (!this.data.templates.some((t) => t.userId === admin.id)) {
      this.data.templates.push(...this.makeDefaultTemplates(admin.id));
    }
    // 清理过期会话
    const now = Date.now();
    for (const token of Object.keys(this.data.sessions)) {
      const s = this.data.sessions[token];
      if (!s || new Date(s.expiresAt).getTime() < now) delete this.data.sessions[token];
    }
  }

  makeDefaultTemplates(userId) {
    return DEFAULT_TEMPLATES().map((t) => ({ ...t, id: genId('tpl'), userId }));
  }

  async _flush() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    await fsp.rename(tmp, this.file);
  }

  save() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._flush().catch((e) => console.error('[store] 保存失败:', e));
    }, 300);
  }

  async flushNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    await this._flush();
  }

  // ---------------- 用户 / 会话 ----------------
  listUsers() {
    return this.data.users.map(sanitizeUser);
  }
  getUser(id) {
    return this.data.users.find((u) => u.id === id) || null;
  }
  getUserByUsername(username) {
    const k = String(username || '').toLowerCase();
    return this.data.users.find((u) => u.username.toLowerCase() === k) || null;
  }
  activeAdminCount() {
    return this.data.users.filter((u) => u.role === 'admin' && u.active !== false).length;
  }
  async addUser({ username, name, role, passwordHash }) {
    const u = {
      id: genId('usr'),
      username,
      name: name || username,
      role: role === 'admin' ? 'admin' : 'user',
      active: true,
      passwordHash,
      createdAt: new Date().toISOString(),
      lastLoginAt: null
    };
    this.data.users.push(u);
    this.data.templates.push(...this.makeDefaultTemplates(u.id));
    this.save();
    return u;
  }
  async updateUser(id, patch) {
    const u = this.getUser(id);
    if (!u) return null;
    Object.assign(u, patch);
    this.save();
    return u;
  }
  async updatePassword(id, passwordHash) {
    const u = this.getUser(id);
    if (!u) return null;
    u.passwordHash = passwordHash;
    this.save();
    return u;
  }
  async deleteUserCascade(id) {
    this.data.users = this.data.users.filter((u) => u.id !== id);
    this.deleteSessionsFor(id);
    this.data.accounts = this.data.accounts.filter((x) => x.userId !== id);
    this.data.templates = this.data.templates.filter((x) => x.userId !== id);
    this.data.jobs = this.data.jobs.filter((x) => x.userId !== id);
    this.data.images = this.data.images.filter((x) => x.userId !== id);
    this.data.logs = this.data.logs.filter((x) => x.userId !== id);
    this.save();
  }

  createSession(userId) {
    const token = newSessionToken();
    this.data.sessions[token] = {
      userId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString()
    };
    this.save();
    return token;
  }
  getSession(token) {
    const s = this.data.sessions[token];
    if (!s) return null;
    if (new Date(s.expiresAt).getTime() < Date.now()) {
      delete this.data.sessions[token];
      this.save();
      return null;
    }
    const u = this.getUser(s.userId);
    if (!u || u.active === false) return null;
    return { user: u };
  }
  deleteSession(token) {
    if (this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.save();
    }
  }
  deleteSessionsFor(userId) {
    for (const token of Object.keys(this.data.sessions)) {
      if (this.data.sessions[token].userId === userId) delete this.data.sessions[token];
    }
    this.save();
  }

  // ---------------- 图库文件夹 ----------------
  listFolders() {
    return this.data.folders;
  }
  getFolder(id) {
    return this.data.folders.find((f) => f.id === id);
  }
  async addFolder(folder) {
    this.data.folders.push(folder);
    this.save();
    return folder;
  }
  async updateFolder(id, patch) {
    const f = this.getFolder(id);
    if (!f) return null;
    Object.assign(f, patch);
    this.save();
    return f;
  }
  /** 删除文件夹，其中的图片回到“未分类” */
  async deleteFolder(id) {
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    this.data.images.forEach((i) => {
      if (i.folderId === id) i.folderId = null;
    });
    this.save();
  }

  // ---------------- accounts ----------------
  listAccounts() {
    return this.data.accounts;
  }
  getAccount(id) {
    return this.data.accounts.find((a) => a.id === id);
  }
  async addAccount(account) {
    this.data.accounts.push(account);
    this.save();
    return account;
  }
  async updateAccount(id, patch) {
    const a = this.getAccount(id);
    if (!a) return null;
    Object.assign(a, patch);
    this.save();
    return a;
  }
  async deleteAccount(id) {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    this.save();
  }

  // ---------------- templates ----------------
  listTemplates() {
    return this.data.templates;
  }
  getTemplate(id) {
    return this.data.templates.find((t) => t.id === id);
  }
  async addTemplate(tpl) {
    this.data.templates.push(tpl);
    this.save();
    return tpl;
  }
  async updateTemplate(id, patch) {
    const t = this.getTemplate(id);
    if (!t) return null;
    Object.assign(t, patch);
    this.save();
    return t;
  }
  async deleteTemplate(id) {
    this.data.templates = this.data.templates.filter((t) => t.id !== id);
    this.save();
  }

  // ---------------- jobs ----------------
  listJobs() {
    return this.data.jobs;
  }
  getJob(id) {
    return this.data.jobs.find((j) => j.id === id);
  }
  async addJob(job) {
    this.data.jobs.push(job);
    this.save();
    return job;
  }
  async updateJob(id, patch) {
    const j = this.getJob(id);
    if (!j) return null;
    Object.assign(j, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return j;
  }
  async deleteJob(id) {
    this.data.jobs = this.data.jobs.filter((j) => j.id !== id);
    this.save();
  }

  // ---------------- logs ----------------
  async addLog(level, message, extra) {
    this.data.logs.unshift({
      time: new Date().toISOString(),
      level,
      message,
      userId: extra && extra.userId,
      ...(extra || {})
    });
    if (this.data.logs.length > 500) this.data.logs.length = 500;
    this.save();
  }
  listLogs() {
    return this.data.logs;
  }

  // ---------------- images ----------------
  listImages() {
    return this.data.images;
  }
  async addImage(meta) {
    this.data.images.unshift(meta);
    this.save();
    return meta;
  }
  async deleteImage(key) {
    this.data.images = this.data.images.filter((i) => i.key !== key);
    this.save();
  }
}

async function createStore(dataDir) {
  await fsp.mkdir(dataDir, { recursive: true });
  const store = new Store(path.join(dataDir, 'db.json'));
  await store.init();
  return store;
}

module.exports = { createStore, Store, genId, sanitizeUser };
