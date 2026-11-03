const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
for (const [page, id] of [['queue', 'tplLink'], ['drafts', 'downloadTemplateLink']]) {
  test(page + ' 下载要求选择、恢复选择并每次附加时间戳', () => {
    const html = fs.readFileSync('public/' + page + '.html', 'utf8');
    assert.match(html, /请选择模板…/);
    assert.ok(html.includes('id="' + id + '" disabled'));
    assert.ok(!html.includes('href="/api/jobs/import-template"'));
    const source = fs.readFileSync('public/js/pages/' + page + '.js', 'utf8');
    const start = source.indexOf('const button =');
    const end = source.indexOf('\n      }', start);
    const code = source.slice(start, end);
    const run = saved => {
      const events = {};
      const button = { addEventListener: (key, fn) => { events[key] = fn; } };
      const select = { value: '', addEventListener: (key, fn) => { events[key] = fn; } };
      let stored = saved, now = 1;
      const location = {};
      vm.runInNewContext(code, { $: () => button, downloadSelect: select, localStorage: { getItem: () => stored, setItem: (_, value) => { stored = value; } }, location, Date: { now: () => now++ } });
      return { events, button, select, location, stored: () => stored };
    };
    const first = run('');
    assert.equal(first.button.disabled, true);
    first.events.click();
    assert.equal(first.location.href, undefined);
    first.select.value = 'tpl_video';
    first.events.change();
    assert.equal(first.button.disabled, false);
    assert.equal(first.stored(), 'tpl_video');
    first.events.click();
    assert.match(first.location.href, /templateId=tpl_video&t=1$/);
    first.events.click();
    assert.match(first.location.href, /&t=2$/);
    const restored = run(first.stored());
    assert.equal(restored.select.value, 'tpl_video');
    assert.equal(restored.button.disabled, false);
  });
}
