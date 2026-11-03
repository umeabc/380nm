'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { Store } = require('../src/store');
const { hashPassword } = require('../src/auth');
const createRoutes = require('../src/routes');
const { importFromUrl, downloadImage } = require('../src/importers');

test('v2 migration preserves legacy IDs and drafts; seeds isolated batch templates once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-v2-'));
  const file = path.join(dir, 'db.json');
  const users = [{ id: 'admin', username: 'admin', role: 'admin', active: true }, { id: 'user', username: 'user', role: 'user', active: true }];
  await fs.writeFile(file, JSON.stringify({ users, templates: [{ id: 'legacy', userId: 'user', name: '旧模板', content: '{{content}}' }], batchDrafts: [{ userId: 'user', rows: [{ config: { templateId: 'legacy' } }] }], settings: { danbooruApiKey: 'old', importProxy: 'proxy' } }));
  try {
    const store = new Store(file); await store.init();
    assert.equal(store.getTemplate('legacy').category, 'dynamic');
    assert.equal(store.getBatchDraft('user').rows[0].config.templateId, 'legacy');
    for (const user of users) assert.ok(store.listTemplates().some(t => t.userId === user.id && t.category === 'batch'));
    assert.equal(store.getSettings().danbooruApiKey, undefined);
    assert.equal(store.getSettings().importProxy, 'proxy');
    const removed = store.listTemplates().find(t => t.userId === 'user' && t.category === 'batch');
    await store.deleteTemplate(removed.id); await store.flushNow();
    const reloaded = new Store(file); await reloaded.init();
    assert.equal(reloaded.getTemplate(removed.id), undefined);
    assert.equal(reloaded.listTemplates().filter(t => t.userId === 'user' && t.category === 'batch').length, 1);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('v2 real HTTP template categories, validation, ownership, signature enqueue and removed source', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), '380nm-v2-http-'));
  const store = new Store(path.join(dir, 'db.json')); await store.init();
  const admin = store.listUsers()[0];
  const user = await store.addUser({ username: 'other', role: 'user', passwordHash: hashPassword('test-pass') });
  const token = store.createSession(admin.id), other = store.createSession(user.id);
  const app = express(); app.use(express.json());
  app.use('/api', createRoutes({ store, storage: {}, bili: {}, scheduler: {} }));
  const server = app.listen(0); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const req = async (method, endpoint, body, session = token) => {
    const response = await fetch(base + '/api' + endpoint, { method, headers: { Cookie: 'sid=' + session, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: response.status, body: json };
  };
  try {
    for (const category of ['dynamic', 'batch']) {
      const result = await req('GET', '/templates?category=' + category);
      assert.equal(result.status, 200); assert.ok(result.body.templates.length);
      assert.ok(result.body.templates.every(t => t.category === category && t.userId === admin.id));
    }
    assert.equal((await req('GET', '/templates?category=wrong')).status, 400);
    const input = { name: '批量测试', category: 'batch', content: '{{credit}}\n{{body}}', signatureFormat: '作者 {{author}} / {{handle}} / {{pixivId}} / {{sourceUrl}}', maxImages: 0, variables: [] };
    for (const patch of [{ category: 'other' }, { signatureFormat: {} }, { signatureFormat: '{{unknown}}' }, { signatureFormat: 'a'.repeat(2001) }]) {
      assert.equal((await req('POST', '/templates', { ...input, ...patch })).status, 400);
    }
    const created = await req('POST', '/templates', input); assert.equal(created.status, 200);
    const tpl = created.body.template; assert.equal(tpl.maxImages, 0); assert.equal(tpl.signatureFormat, input.signatureFormat);
    assert.equal((await req('PUT', '/templates/' + tpl.id, input, other)).status, 404);
    assert.equal((await req('DELETE', '/templates/' + tpl.id, undefined, other)).status, 404);
    assert.ok(!(await req('GET', '/templates?category=batch', undefined, other)).body.templates.some(t => t.id === tpl.id));
    const update = await req('PUT', '/templates/' + tpl.id, { name: '改名', content: input.content, maxImages: 0, variables: [] });
    assert.equal(update.body.template.category, 'batch'); assert.equal(update.body.template.signatureFormat, input.signatureFormat);
    await store.addAccount({ id: 'acc-v2', userId: admin.id, name: 'test' });
    const row = { id: 'v2-row', status: 'ready', config: { templateId: tpl.id, accountId: 'acc-v2' }, url: 'https://pixiv.net/artworks/1', images: [], selectedImages: [], scheduledAt: new Date(Date.now() + 3600000).toISOString(), body: '正文', variables: { author: '作者名', handle: 'artist', pixivId: '42' } };
    const saved = await req('PUT', '/batch-draft', { revision: 0, rows: [row], config: {} }); assert.equal(saved.status, 200);
    const queued = await req('POST', '/batch-draft/enqueue', { revision: saved.body.revision, rowIds: [row.id] });
    assert.equal(queued.body.failed.length, 0); assert.equal(queued.body.created.length, 1);
    assert.equal(store.listJobs()[0].text, '作者 作者名 / artist / 42 / https://pixiv.net/artworks/1\n正文');
    for (const key of ['origAuthor', 'OrigAuthor']) {
      const updated = await req('PUT', '/templates/' + tpl.id, { ...input, signatureFormat: 'By {{' + key + '}}' });
      assert.equal(updated.status, 200);
      const current = (await req('GET', '/batch-draft')).body;
      const nextRow = { ...row, id: 'orig-' + key, credit: 'stale', variables: { origAuthor: 'New' } };
      const savedOrig = await req('PUT', '/batch-draft', { revision: current.revision, rows: [nextRow], config: {} });
      const queuedOrig = await req('POST', '/batch-draft/enqueue', { revision: savedOrig.body.revision, rowIds: [nextRow.id] });
      assert.deepEqual(queuedOrig.body.failed, []);
      assert.equal(store.getJob(queuedOrig.body.created[0].id).text, 'By New\n' + row.body);
    }
    await req('PUT', '/templates/' + tpl.id, input);
    // 真实前端保存元数据对象：服务端仅持久化经过所有权验证的 key。
    const imageObjects = [];
    for (let i = 0; i < 12; i++) {
      const image = { key: 'v2-image-' + i, userId: admin.id, name: '图' + i, url: '/uploads/' + i };
      await store.addImage(image); imageObjects.push(image);
    }
    const translated = (await req('POST', '/templates', { ...input, name: '翻嵌', maxImages: 9, content: '{{credit}}\n翻译 {{translator}} 嵌字 {{typesetter}}\n{{body}}' })).body.template;
    const row2 = { ...row, id: 'translation-row', config: { ...row.config, templateId: translated.id }, credit: '自定义作者署名', body: '独立正文', images: imageObjects, selectedImages: [imageObjects[0]], variables: { translator: '@translator', typesetter: '@typesetter' } };
    const saved2 = await req('PUT', '/batch-draft', { revision: (await req('GET', '/batch-draft')).body.revision, rows: [row2], config: {} });
    assert.equal(saved2.status, 200); assert.equal(saved2.body.rows[0].images.length, 12);
    assert.deepEqual(saved2.body.rows[0].selectedImages, ['v2-image-0']);
    const queued2 = await req('POST', '/batch-draft/enqueue', { revision: saved2.body.revision, rowIds: [row2.id, row2.id] });
    assert.equal(queued2.body.failed.length, 0); assert.equal(store.listJobs().filter(j => j.sourceDraftId === row2.id).length, 1);
    assert.equal(store.listJobs().find(j => j.sourceDraftId === row2.id).text, '自定义作者署名\n翻译 @translator 嵌字 @typesetter\n独立正文');
    const oldTemplate = store.listTemplates().find(t => t.userId === admin.id && t.category === 'dynamic' && t.content === '{{content}}');
    const oldRow = { ...row, id: 'legacy-row', config: { ...row.config, templateId: oldTemplate.id }, body: '旧草稿正文和署名', credit: '旧署名' };
    const savedOld = await req('PUT', '/batch-draft', { revision: queued2.body.revision, rows: [oldRow], config: {} });
    const queuedOld = await req('POST', '/batch-draft/enqueue', { revision: savedOld.body.revision, rowIds: [oldRow.id] });
    assert.equal(queuedOld.body.failed.length, 0); assert.equal(store.listJobs().find(j => j.sourceDraftId === oldRow.id).text, oldRow.body);
    let revision = queuedOld.body.revision;
    for (const patch of [{ body: 'x'.repeat(2001) }, { credit: 'x'.repeat(2001) }, { variables: { translator: 'x'.repeat(2001) } }, { variables: { translator: {} } }]) {
      assert.equal((await req('PUT', '/batch-draft', { revision, rows: [{ ...row2, ...patch }], config: {} })).status, 400);
    }
    const stolen = { key: 'foreign', userId: user.id, url: '/foreign' }; await store.addImage(stolen);
    assert.equal((await req('PUT', '/batch-draft', { revision, rows: [{ ...row2, images: [stolen], selectedImages: [stolen] }], config: {} })).status, 400);
    const revokedRow = { ...row2, id: 'revoked-row' };
    const revSaved = await req('PUT', '/batch-draft', { revision, rows: [revokedRow], config: {} });
    store.listImages().find(i => i.key === 'v2-image-0').userId = user.id;
    const revokedQueue = await req('POST', '/batch-draft/enqueue', { revision: revSaved.body.revision, rowIds: [revokedRow.id] });
    assert.equal(revokedQueue.body.created.length, 0); assert.match(revokedQueue.body.failed[0].error, /不属于当前用户/);
    assert.equal((await req('GET', '/danbooru/thumb?url=https://cdn.donmai.us/a.jpg')).status, 404);
    assert.equal((await req('PUT', '/settings', { danbooruKey: 'x' })).status, 400);
    for (const url of ['https://danbooru.donmai.us/posts/1', 'https://cdn.donmai.us/a.jpg']) {
      await assert.rejects(importFromUrl(url), /该图源已移除/);
      await assert.rejects(downloadImage(url), /该图源已移除/);
    }
    await assert.rejects(fs.access(path.join(__dirname, '../public/danbooru.html')));
    await assert.rejects(fs.access(path.join(__dirname, '../public/js/pages/danbooru.js')));
  } finally {
    await new Promise(r => server.close(r)); await store.flushNow(); await fs.rm(dir, { recursive: true, force: true });
  }
});
