'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const createRoutes = require('../src/routes');
const { importFromUrl, parseWork } = require('../src/importers');

function mockWork(t, platform, count = 35, allowedDownloads = 30) {
  const urls = Array.from({ length: count }, (_, i) => platform === 'pixiv'
    ? `https://i.pximg.net/test/p${i + 1}.png`
    : `https://pbs.twimg.com/media/p${i + 1}.png`);
  const downloads = [];
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === 'https://www.pixiv.net/ajax/illust/123') {
      return { ok: true, status: 200, json: async () => ({ body: {
        illustTitle: '多页作品', userName: '作者', userId: '456', pageCount: count, urls: { original: urls[0] }
      } }) };
    }
    if (url === 'https://www.pixiv.net/ajax/illust/123/pages') {
      return { ok: true, status: 200, json: async () => ({ body: urls.map(original => ({ urls: { original } })) }) };
    }
    if (url.startsWith('https://cdn.syndication.twimg.com/tweet-result?')) {
      return { ok: true, status: 200, json: async () => ({
        text: '多图推文', user: { screen_name: 'artist', name: '作者' },
        mediaDetails: urls.map(media_url_https => ({ media_url_https }))
      }) };
    }
    const index = urls.indexOf(url.replace('?name=orig', ''));
    assert.ok(index >= 0, `不应请求未知地址：${url}`);
    assert.ok(index < allowedDownloads, `不应下载上限之后的第 ${index + 1} 张图片`);
    downloads.push(url);
    return {
      ok: true, status: 200, headers: { get: () => 'image/png' },
      arrayBuffer: async () => Uint8Array.of(index + 1).buffer
    };
  });
  return { downloads, urls, url: platform === 'pixiv' ? 'https://www.pixiv.net/artworks/123' : 'https://x.com/artist/status/123' };
}

async function fixture(t) {
  const saved = [], logs = [], writes = [];
  const user = { id: 'user', role: 'user', username: 'tester', active: true };
  const store = {
    getSession: token => token === 'test' ? { user } : null,
    getSettings: () => ({}),
    addImage: async meta => { saved.push(meta); },
    addLog: async (level, message) => { logs.push(message); }
  };
  const storage = {
    name: 'local',
    put: async (buffer, name) => {
      writes.push({ buffer, name });
      const key = `image-${writes.length}`;
      return { key, url: '/uploads/' + key };
    }
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createRoutes({ store, storage, bili: {}, scheduler: {} }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  function post(path, url) {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path,
        headers: { 'Content-Type': 'application/json', Cookie: 'sid=test' } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ url }));
    });
  }
  return { post, saved, logs, writes };
}

for (const platform of ['pixiv', 'x']) {
  for (const endpoint of ['import', 'parse-work']) {
    test(`${platform} ${endpoint} 在下载前截取 30 张，保留总数、顺序与提示`, async t => {
      const source = mockWork(t, platform);
      const api = await fixture(t);
      const response = await api.post('/api/library/' + endpoint, source.url);
      assert.equal(response.status, 200);
      let result;
      if (endpoint === 'parse-work') {
        const events = response.text.trim().split('\n').map(line => JSON.parse(line));
        const progress = events.filter(event => event.type === 'progress');
        assert.deepEqual(progress.map(event => event.step), [0, 1, 2, 3]);
        assert.match(progress[2].sub, /共 35 张.*已截取前 30 张/);
        result = events.at(-1);
        assert.equal(result.type, 'done');
        assert.equal(result.work.platform, platform);
      } else {
        result = JSON.parse(response.text);
        assert.match(api.logs[0], /超出上限，已截取前 30 张/);
      }
      assert.equal(result.total, 35);
      assert.equal(result.images.length, 30);
      assert.equal(api.saved.length, 30);
      assert.deepEqual(source.downloads, source.urls.slice(0, 30).map(url => platform === 'x' ? url + '?name=orig' : url));
      assert.deepEqual(api.writes.map(write => write.buffer[0]), Array.from({ length: 30 }, (_, i) => i + 1));
      assert.ok(api.writes.every((write, i) => write.name.endsWith(`-P${i + 1}.png`)));
    });
  }
}

test('未指定下载上限时，导入与解析保持原有完整下载行为', async t => {
  const source = mockWork(t, 'pixiv', 35, 35);
  const imported = await importFromUrl(source.url);
  assert.ok(Array.isArray(imported));
  assert.equal(imported.length, 35);
  assert.equal(imported.total, 35);
  const parsed = await parseWork(source.url);
  assert.equal(parsed.images.length, 35);
  assert.equal(parsed.total, 35);
  assert.equal(source.downloads.length, 70);
});
