const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
test('imageSrc逐段编码、固定尺寸、预览和原对象不变', () => {
  const sandbox = { window: {}, document: {} };
  vm.runInNewContext(read('public/js/common.js'), sandbox);
  const image = { key: 'dyn/中文 空格#&.png', url: 'https://original.test/image.png', name: 'x' };
  const before = JSON.stringify(image);
  assert.equal(sandbox.window.App.imageSrc(image), '/api/thumb/dyn/' + encodeURIComponent('中文 空格#&.png') + '?w=240');
  assert.match(sandbox.window.App.imageSrc(image, 480), /w=480$/);
  assert.equal(JSON.stringify(image), before);
  for (const url of ['blob:foo', 'data:image/png;base64,xx']) assert.equal(sandbox.window.App.imageSrc({ key: 'x', url }), url);
  assert.equal(sandbox.window.App.imageSrc({ url: 'avatar' }), 'avatar');
  assert.throws(() => sandbox.window.App.imageSrc(image, 960));
});
test('表4全部小图接入，原图放大和外部边界保持', () => {
  const counts = { library: 1, queue: 2, job: 2, release: 3, batch: 2 };
  for (const [page, count] of Object.entries(counts)) {
    const text = read(`public/js/pages/${page}.js`);
    assert.equal((text.match(/App\.imageSrc\(/g) || []).length, count);
    assert.doesNotMatch(text, /<img[^>]*src="\$\{esc\([^)]*\.url\)\}"/);
  }
  assert.match(read('public/js/pages/queue.js'), /img\.src = im\.url;/);
  assert.match(read('public/js/pages/job.js'), /href="\$\{esc\(i\.url\)\}"/);
  assert.doesNotMatch(read('public/js/pages/dashboard.js'), /<img/);
  for (const p of ['accounts', 'danbooru']) assert.doesNotMatch(read(`public/js/pages/${p}.js`), /App\.imageSrc/);
});
