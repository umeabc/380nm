const path = require('path');
const express = require('express');
const { config } = require('./src/config');
const { createStore } = require('./src/store');
const { createStorage } = require('./src/storage');
const { BilibiliClient } = require('./src/bilibili');
const { PassportClient } = require('./src/bilibili-passport');
const { AccountCredentialsLock } = require('./src/account-credentials-lock');
const { CookieRefreshService } = require('./src/cookie-refresh');
const { QrLoginService } = require('./src/qrcode-login');
const { Scheduler } = require('./src/scheduler');
const { CookieMonitor } = require('./src/cookie-monitor');
const createRoutes = require('./src/routes');

async function main() {
  const store = await createStore(config.dataDir);
  const storage = await createStorage(config);
  const bili = new BilibiliClient();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20mb' }));

  if (storage.name === 'local') {
    app.use('/uploads', express.static(storage.dir, { maxAge: '7d' }));
  }

  // 页面路由（多页应用）
  const page = (name) => (req, res) => res.sendFile(path.join(__dirname, 'public', name + '.html'));
  app.get('/', (req, res) => res.redirect('/dashboard'));
  app.get('/login', page('login'));
  app.get('/dashboard', page('dashboard'));
  app.get('/release', page('release'));
  app.get('/batch', page('batch'));
  app.get('/queue', page('queue'));
  app.get('/queue/:id', page('job'));
  app.get('/library', page('library'));
  app.get('/danbooru', page('danbooru'));
  app.get('/templates', page('templates'));
  app.get('/templates/:id', page('template-edit'));
  app.get('/libaccounts', page('libaccounts'));
  app.get('/accounts', page('accounts'));
  app.get('/users', page('users'));
  app.get('/settings', page('settings'));
  app.get('/log', page('log'));

  app.use(express.static(path.join(__dirname, 'public')));

  // 进程内账号级凭据锁 + 共享服务：续期、扫码、发布、手动改 Cookie 共用同一把锁
  const credentialsLock = new AccountCredentialsLock();
  const passport = new PassportClient();
  const cookieRefresh = new CookieRefreshService({
    store, passport, bili, lock: credentialsLock,
    dataDir: config.dataDir, enabled: config.cookieAutoRefresh
  });
  const qrLogin = new QrLoginService({ store, passport, bili, lock: credentialsLock, refresh: cookieRefresh });

  const scheduler = new Scheduler({ store, storage, bili, config: config.scheduler, lock: credentialsLock });
  const cookieMonitor = new CookieMonitor({ store, bili, config: config.cookieMonitor, refresh: cookieRefresh, lock: credentialsLock });
  app.use('/api', createRoutes({
    store, storage, bili, scheduler, cookieMonitor,
    qrLogin, cookieRefresh, credentialsLock
  }));

  app.use((err, req, res, next) => {
    console.error('[http]', err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
  });

  scheduler.start();
  cookieMonitor.start();

  const server = app.listen(config.port, config.host, () => {
    console.log('==================================================');
    console.log('  B站动态定时发布后台已启动');
    console.log(`  地址: http://${config.host}:${config.port}`);
    console.log(`  存储: ${storage.name === 'local' ? '本地 ' + storage.dir : 'Cloudflare R2'}`);
    console.log(`  调度: 每 ${config.scheduler.intervalMs / 1000}s 检查一次队列`);
    console.log(`  账号自动续期: ${config.cookieAutoRefresh ? '开启' : '关闭（仅保留巡检/扫码）'}`);
    console.log('  Ctrl+C 停止服务');
    console.log('==================================================');
  });

  const shutdown = async () => {
    console.log('\n正在退出...');
    scheduler.stop();
    cookieMonitor.stop();
    server.close();
    // 先中止在途续期/扫码并等待其落盘，再 flush Store，避免退出丢链
    try { await cookieRefresh.close(); } catch (e) { console.error(e); }
    try { await qrLogin.close(); } catch (e) { console.error(e); }
    passport.close();
    try {
      await store.flushNow();
    } catch (e) {
      console.error(e);
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
