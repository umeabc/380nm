'use strict';

// Optional real-browser regression check: node tests/release-layout-browser.cjs
// Requires Node 24 and Edge/Chrome, but no npm/browser package or application server.
// Set RELEASE_LAYOUT_BROWSER to use a different Chromium executable.
// Add --screenshots to retain the 1280px top/bottom views in a printed temp folder.
// Real page/CSS and rendering functions are used with controlled data; App.boot is
// disabled so this cannot fetch accounts, save drafts, or enqueue a publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, 'public', name), 'utf8');
const browserPath = [process.env.RELEASE_LAYOUT_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(candidate => candidate && fs.existsSync(candidate));

function fixture() {
  const html = read('release.html').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  const release = read('js/pages/release.js').replace(/\}\)\(\);\s*$/, `
    window.releaseFixture = { state, renderSelected, renderPickFolders,
      renderImageGrid, renderTplHint, renderFetch,
      setTemplate(id) { activeTplId = id; } };
  })();`);
  assert.ok(release.includes('window.releaseFixture'), 'release.js fixture hook must be inserted');
  const setup = `
    window.fetch = () => Promise.reject(new Error('Business requests are disabled in layout tests'));
    ${read('js/common.js')}
    App.boot = async () => {};
    ${release}
    (${populate.toString()})();
  `;
  return { html: html.replace('</body>', '<script src="/layout-fixture.js"></script></body>'), setup };
}

function populate() {
  App.state.user = { id: 'layout-fixture', username: 'layout', name: '管理员', role: 'admin' };
  App.renderShell('release', '发布动态');
  window.layoutVisibility = App.cardVisibility({ key: 'release-layout-browser' });
  document.querySelector('#no-account-warn').style.display = '';
  const p = window.releaseFixture;
  const svg = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><rect width="240" height="240" fill="#d7c4f5"/><circle cx="120" cy="120" r="70" fill="#7951cf"/></svg>');
  p.state.images = Array.from({ length: 6 }, (_, i) => ({
    key: 'fixture-' + i, name: '布局回归图片 ' + (i + 1), url: svg, folderId: 'long-folder-0'
  }));
  p.state.folders = Array.from({ length: 5 }, (_, i) => ({
    id: 'long-folder-' + i, name: '导入 2026-11-03 长文件夹名称用于检查完整换行 ' + i
  }));
  p.state.selected = [...p.state.images, ...Array.from({ length: 3 }, (_, i) => ({
    key: 'extra-' + i, name: '其他文件夹选图 ' + i, url: svg
  }))];
  p.state.jobs = [
    { status: 'published', images: p.state.images, publishedAt: '2026-11-01T02:00:00Z' },
    { status: 'pending', images: p.state.images, scheduledAt: '2026-11-05T02:00:00Z' }
  ];
  p.state.templates = [{ id: 'long-template', maxImages: 9,
    name: '每日早报 · 长模板名称用于检查自动内容行高与换行',
    content: '{{date}} {{news}} {{ending}} '.repeat(8), variables: [{}, {}, {}]
  }];
  p.setTemplate('long-template');
  p.renderTplHint();
  p.renderPickFolders();
  p.renderSelected();
  p.renderImageGrid();
  p.renderFetch();
  document.querySelector('#sel-account').innerHTML = '<option>请选择账号</option>';
  document.querySelector('#sel-template').innerHTML = '<option>每日早报</option>';
  document.querySelector('#var-fields').innerHTML =
    '<div class="field"><label>日期</label><input class="ctl" value="11月3日 星期二"></div>' +
    '<div class="field"><label>早报内容</label><textarea class="ctl" rows="4">多条新闻，一行一条</textarea></div>' +
    '<div class="field"><label>结尾语</label><input class="ctl" value="祝大家有美好的一天"></div>';
  document.querySelector('#var-people').innerHTML = '<div class="field"><label>参与人员</label><div class="chips"><span class="chip">翻译人员</span><span class="chip">嵌字人员</span></div></div>';
  document.querySelector('#preview-text').textContent =
    '正文预览必须保留至少 120px。长正文在预览内滚动，不能挤掉提交按钮。\n'.repeat(40);
  document.querySelector('#composeSummary').textContent = '已选择 9 张图片 · 正文 1200 字 · 计划时间待填写';
  window.layoutFixtureReady = true;
}

async function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    const request = pending.get(result.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(result.id);
    if (result.error) request.reject(new Error(JSON.stringify(result.error)));
    else request.resolve(result.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Browser connection closed during ' + request.method));
    }
    pending.clear();
  });
  return {
    socket,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 10000);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    }
  };
}

function measure() {
  const rect = node => {
    const r = node.getBoundingClientRect();
    return { x: r.x, y: r.y, top: r.top, right: r.right, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
  };
  const cardShown = selector => !document.querySelector(selector).classList.contains('workspace-card-hidden');
  const grid = document.querySelector('#img-grid');
  const title = document.querySelector('.release-images .g-title');
  const range = document.createRange();
  range.selectNodeContents(title);
  const presets = Array.from(document.querySelectorAll('#presets button')).map(rect);
  const preview = document.querySelector('#preview-text');
  const board = document.querySelector('.release-board');
  return {
    viewport: { width: innerWidth, height: innerHeight },
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    board: rect(board),
    title: rect(title), titleLines: range.getClientRects().length,
    hint: rect(document.querySelector('#imgHint')),
    upload: rect(document.querySelector('#pick-upload-btn')),
    imagesShown: cardShown('.release-images'), submitShown: cardShown('.release-submit'),
    grid: rect(grid), columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
    gap: getComputedStyle(grid).gap,
    cells: Array.from(grid.querySelectorAll('.cell')).map(cell => ({
      rect: rect(cell), badges: Array.from(cell.querySelectorAll('.ord,.pub-badge,.pend-badge')).map(rect)
    })),
    firstPresetRow: presets.filter(r => Math.abs(r.top - presets[0].top) < 2).length,
    preview: rect(preview), previewScroll: preview.scrollHeight > preview.clientHeight,
    footer: rect(document.querySelector('.release-submit .card-foot')),
    submitCard: rect(document.querySelector('.release-submit')),
    buttons: ['#btn-save-draft', '#btn-submit'].map(s => rect(document.querySelector(s))),
    clippedBodies: Array.from(board.querySelectorAll('.group:not(.workspace-card-hidden)>.card-body')).filter(body =>
      body.scrollHeight > body.clientHeight + 1 && ['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(body).overflowY)
    ).map(body => body.parentNode.dataset.cardId)
  };
}

function verify(metrics, context) {
  const check = (value, reason) => assert.ok(value, context + ': ' + reason);
  check(metrics.horizontalOverflow <= 1, 'page must not scroll horizontally: ' + metrics.horizontalOverflow);
  check(metrics.clippedBodies.length === 0, 'whole card body clipped: ' + metrics.clippedBodies.join(','));
  if (metrics.imagesShown) {
    check(metrics.titleLines === 1, 'image title must occupy one text line');
    for (const item of [metrics.hint, metrics.upload]) {
      check(Math.abs(item.top + item.height / 2 - metrics.title.top - metrics.title.height / 2) <= 5,
        'title, selection count, and upload must share one line');
    }
    check(metrics.columns === 2, 'image grid must have exactly two columns');
    check(metrics.gap === '8px', 'image grid gap must be 8px');
    if (metrics.viewport.width === 1280) check(metrics.grid.width >= 200, 'image grid width must be >=200px');
    for (const cell of metrics.cells) {
      check(Math.abs(cell.rect.width - cell.rect.height) <= 1, 'thumbnail must be square');
      for (const badge of cell.badges) {
        check(badge.left >= cell.rect.left && badge.right <= cell.rect.right + 1 &&
          badge.top >= cell.rect.top && badge.bottom <= cell.rect.bottom + 1, 'image badge must stay inside thumbnail');
      }
    }
  }
  if (metrics.submitShown) {
    check(metrics.firstPresetRow >= 2 && metrics.firstPresetRow <= 3, 'first quick-time row must hold 2–3 buttons, found ' + metrics.firstPresetRow);
    check(metrics.preview.height >= 120, 'preview must retain at least 120px');
    check(metrics.previewScroll, 'long preview must scroll inside its own box');
  }
}

async function main() {
  assert.ok(browserPath, 'Install Edge/Chrome or set RELEASE_LAYOUT_BROWSER to its executable');
  const { html, setup } = fixture();
  const unexpectedRequests = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const routes = {
      '/release': ['text/html; charset=utf-8', html],
      '/css/app.css': ['text/css; charset=utf-8', read('css/app.css')],
      '/layout-fixture.js': ['text/javascript; charset=utf-8', setup]
    };
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (!routes[pathname]) { unexpectedRequests.push(pathname); response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': routes[pathname][0], 'Cache-Control': 'no-store' });
    response.end(routes[pathname][1]);
  });
  let browser, cdp, profile, screenshots, browserLog = '';
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = await fsp.mkdtemp(path.join(os.tmpdir(), '380nm-release-layout-'));
    // GPU subprocesses are unavailable in some Windows CI sandboxes. This isolated
    // browser only opens the controlled loopback fixture and is always torn down.
    browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--in-process-gpu', '--disable-gpu-sandbox', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr.on('data', chunk => { browserLog = (browserLog + chunk).slice(-4000); });
    let launchError;
    browser.once('error', error => { launchError = error; });
    const activePort = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !fs.existsSync(activePort); i++) {
      if (launchError) throw launchError;
      if (browser.exitCode !== null) throw new Error('Browser exited: ' + browser.exitCode);
      await delay(100);
    }
    assert.ok(fs.existsSync(activePort), 'Browser did not expose a debugging port within 15 seconds');
    const debugPort = Number(fs.readFileSync(activePort, 'utf8').split(/\r?\n/)[0]);
    const pages = await fetch('http://127.0.0.1:' + debugPort + '/json/list').then(r => r.json());
    const page = pages.find(target => target.type === 'page');
    assert.ok(page, 'Browser must expose a page target');
    cdp = await connect(page.webSocketDebuggerUrl);
    const capture = async name => {
      if (!process.argv.includes('--screenshots')) return;
      screenshots ||= await fsp.mkdtemp(path.join(os.tmpdir(), '380nm-release-screenshots-'));
      const result = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const filename = path.join(screenshots, name + '.png');
      await fsp.writeFile(filename, Buffer.from(result.data, 'base64'));
      console.log('SCREENSHOT ' + filename);
    };
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await cdp.send('Page.enable');
    for (const [width, height] of [[1280, 800], [1024, 768], [375, 812]]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/release' });
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        ready = await evaluate('Boolean(window.layoutFixtureReady)');
        if (!ready) await delay(50);
      }
      assert.ok(ready, 'Fixture did not load');
      await evaluate('document.fonts.ready.then(() => true)');
      await frames();
      for (const hidden of [null, 'target', 'title', 'variables', 'fetch', 'images', 'submit']) {
        await evaluate(`for (const card of document.querySelectorAll('[data-card-id]')) layoutVisibility.setVisible(card.dataset.cardId, card.dataset.cardId !== ${JSON.stringify(hidden)}); window.scrollTo(0, 0);`);
        await frames();
        const before = await evaluate('(' + measure.toString() + ')()');
        const context = width + 'x' + height + (hidden ? ', hidden=' + hidden : ', all cards');
        verify(before, context);
        if (!hidden && width === 1280) assert.ok(before.board.top >= 190 && before.board.top <= 220, 'Fixture must match screenshot board offset near 202px');
        if (!hidden && width === 1280) await capture('1280-top');
        await evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
        await frames();
        const after = await evaluate('(' + measure.toString() + ')()');
        if (!hidden && width === 1280) await capture('1280-bottom');
        if (after.submitShown) {
          assert.ok(after.footer.top >= 0 && after.footer.bottom <= height - 24 + 1, context + ': footer must be fully visible with >=24px bottom space');
          for (const button of after.buttons) assert.ok(button.top >= after.footer.top && button.bottom <= height - 24 + 1, context + ': both actions must be fully visible');
          assert.ok(after.submitCard.bottom <= height - 24 + 1, context + ': submit card must retain >=24px bottom space');
        }
        console.log('PASS ' + context + ': grid=' + before.grid.width.toFixed(1) + 'px, preview=' + before.preview.height.toFixed(1) + 'px, footer gap=' + (height - after.submitCard.bottom).toFixed(1) + 'px');
      }
    }
    assert.deepEqual(unexpectedRequests, [], 'Fixture must not request business APIs or external images');
    console.log('PASS 21 browser layout scenarios; no application service or dependencies used');
  } catch (error) {
    if (/Browser|CDP|Fixture did not load/.test(error.message) && browserLog) console.error(browserLog);
    throw error;
  } finally {
    if (cdp) {
      await cdp.send('Browser.close').catch(() => {});
      cdp.socket.close();
    }
    if (browser && browser.exitCode === null) {
      for (let i = 0; i < 30 && browser.exitCode === null; i++) await delay(100);
      if (browser.exitCode === null && browser.pid) {
        if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(browser.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else browser.kill('SIGKILL');
      }
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (profile) {
      // Only remove this invocation's exact mkdtemp directory inside the OS temp root.
      const resolved = path.resolve(profile);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('380nm-release-layout-'));
      await fsp.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
