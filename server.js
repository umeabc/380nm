const path = require('path');
const express = require('express');
const { config } = require('./src/config');
const { createStore } = require('./src/store');
const { createStorage } = require('./src/storage');
const { BilibiliClient } = require('./src/bilibili');
const { Scheduler } = require('./src/scheduler');
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
  app.use(express.static(path.join(__dirname, 'public')));

  const scheduler = new Scheduler({ store, storage, bili, config: config.scheduler });
  app.use('/api', createRoutes({ store, storage, bili, scheduler }));

  app.use((err, req, res, next) => {
    console.error('[http]', err);
    res.status(500).json({ error: err.message || '服务器内部错误' });
  });

  scheduler.start();

  const server = app.listen(config.port, config.host, () => {
    console.log('==================================================');
    console.log('  B站动态定时发布后台已启动');
    console.log(`  地址: http://${config.host}:${config.port}`);
    console.log(`  存储: ${storage.name === 'local' ? '本地 ' + storage.dir : 'Cloudflare R2'}`);
    console.log(`  调度: 每 ${config.scheduler.intervalMs / 1000}s 检查一次队列`);
    console.log('  Ctrl+C 停止服务');
    console.log('==================================================');
  });

  const shutdown = async () => {
    console.log('\n正在退出...');
    scheduler.stop();
    server.close();
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
