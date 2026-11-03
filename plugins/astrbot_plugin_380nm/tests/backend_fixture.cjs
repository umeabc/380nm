'use strict';

// Python owns this dedicated temporary directory and removes it after shutdown.
// No production server, scheduler, network fetch, or account credentials are used.
const fs = require('fs');
const path = require('path');
const os = require('os');
const dataDir = path.resolve(process.argv[2] || '');
const tempRoot = fs.realpathSync(os.tmpdir());
if (path.dirname(fs.realpathSync(dataDir)) !== tempRoot ||
    !path.basename(dataDir).startsWith('astrbot-380nm-integration-') ||
    fs.readFileSync(path.join(dataDir, '.fixture-owned'), 'utf8') !== '380nm integration fixture\n') {
  throw new Error('Refusing a non-fixture data directory');
}
process.env.DATA_DIR = dataDir;
process.env.UPLOAD_DIR = path.join(dataDir, 'uploads');
process.env.STORAGE_DRIVER = 'local';
process.env.COOKIE_AUTO_REFRESH = '0';
process.env.TRUST_PROXY = '0';

const root = path.resolve(__dirname, '../../..');
const express = require(path.join(root, 'node_modules/express'));
const { Store } = require(path.join(root, 'src/store'));
const { hashPassword } = require(path.join(root, 'src/auth'));
const { LocalStorage } = require(path.join(root, 'src/storage/local'));
const importers = require(path.join(root, 'src/importers'));
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcffff3f0300050001ff0b1a2f0000000049454e44ae426082', 'hex');
let parseCalls = 0;

// This is the only substituted production function. Everything from HTTP
// authentication through NDJSON, image storage, draft rendering and persistence
// runs through the real application code.
importers.parseWork = async (url, settings, onProgress) => {
  parseCalls += 1;
  for (let step = 0; step < 4; step += 1) onProgress(step, 'fixture progress ' + step);
  const description = '这是超过三十个字的作者原文，用来确认完整说明不会被作品标题截断。\n第二段保留换行、emoji 🌟 和 & 符号。';
  return {
    work: {
      platform: 'x', workId: '1234567890123456789',
      title: description.slice(0, 30), author: '测试作者', handle: 'fixture_artist',
      url, text: description, description
    },
    images: [1, 2].map(n => ({ buffer: png, contentType: 'image/png', name: `fixture-${n}.png` }))
  };
};
const createRoutes = require(path.join(root, 'src/routes'));

async function main() {
  const store = new Store(path.join(dataDir, 'db.json'));
  store.data.users.push({
    id: 'fixture-user', username: 'fixture-user', name: 'Fixture user',
    passwordHash: hashPassword('fixture-password'), role: 'user', active: true
  });
  await store.init();
  const storage = new LocalStorage(process.env.UPLOAD_DIR);
  await storage.init();
  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes({ store, storage }));
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    console.error(err.stack || err.message);
    res.status(500).json({ error: 'fixture request failed' });
  });
  const server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  process.stdout.write(JSON.stringify({ base_url: `http://127.0.0.1:${server.address().port}` }) + '\n');
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    await store.flushNow();
    process.stdout.write(JSON.stringify({ stopped: true, parseCalls }) + '\n', () => process.exit(0));
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', text => { if (text.includes('shutdown')) stop().catch(fail); });
  process.stdin.on('end', () => stop().catch(fail));
  process.on('SIGTERM', () => stop().catch(fail));
  process.on('SIGINT', () => stop().catch(fail));
}

function fail(error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
main().catch(fail);
