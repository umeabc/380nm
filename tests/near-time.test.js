/* 380nm · near-time 逻辑测试（node:test + node:assert）*/
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');

// 加载 near-time.js 到 vm 沙箱（与 schedule.test.js 风格一致）
const code = fs.readFileSync(path.join(__dirname, '../public/js/near-time.js'), 'utf8');
const sandbox = { window: {}, module: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const NearTime = sandbox.window.NearTime || sandbox.module.exports;

describe('NearTime.classifyTime', () => {
  const now = new Date('2026-10-27T14:00:00Z').getTime();
  const TEN_MIN = 10 * 60 * 1000;

  it('空串 → empty, needsConfirm=true', () => {
    const r = NearTime.classifyTime('', now, TEN_MIN);
    assert.strictEqual(r.kind, 'empty');
    assert.ok(isNaN(r.atMs));
    assert.strictEqual(r.needsConfirm, true);
  });

  it('非法时间 → invalid, needsConfirm=false', () => {
    const r = NearTime.classifyTime('not-a-date', now, TEN_MIN);
    assert.strictEqual(r.kind, 'invalid');
    assert.ok(isNaN(r.atMs));
    assert.strictEqual(r.needsConfirm, false);
  });

  it('过去时间（-1ms）→ past, needsConfirm=true', () => {
    const past = new Date(now - 1).toISOString();
    const r = NearTime.classifyTime(past, now, TEN_MIN);
    assert.strictEqual(r.kind, 'past');
    assert.strictEqual(r.deltaMs, -1);
    assert.strictEqual(r.needsConfirm, true);
  });

  it('当前时刻（0ms）→ near, needsConfirm=true', () => {
    const exact = new Date(now).toISOString();
    const r = NearTime.classifyTime(exact, now, TEN_MIN);
    assert.strictEqual(r.kind, 'near');
    assert.strictEqual(r.deltaMs, 0);
    assert.strictEqual(r.needsConfirm, true);
  });

  it('恰好 10 分钟后 → near, needsConfirm=true', () => {
    const tenMin = new Date(now + TEN_MIN).toISOString();
    const r = NearTime.classifyTime(tenMin, now, TEN_MIN);
    assert.strictEqual(r.kind, 'near');
    assert.strictEqual(r.deltaMs, TEN_MIN);
    assert.strictEqual(r.needsConfirm, true);
  });

  it('10 分钟 + 1ms → future, needsConfirm=false', () => {
    const beyond = new Date(now + TEN_MIN + 1).toISOString();
    const r = NearTime.classifyTime(beyond, now, TEN_MIN);
    assert.strictEqual(r.kind, 'future');
    assert.strictEqual(r.deltaMs, TEN_MIN + 1);
    assert.strictEqual(r.needsConfirm, false);
  });

  it('30 分钟阈值：恰好 30 分钟 → near', () => {
    const THIRTY = 30 * 60 * 1000;
    const t = new Date(now + THIRTY).toISOString();
    const r = NearTime.classifyTime(t, now, THIRTY);
    assert.strictEqual(r.kind, 'near');
    assert.strictEqual(r.needsConfirm, true);
  });

  it('30 分钟阈值：30 分钟 + 1ms → future', () => {
    const THIRTY = 30 * 60 * 1000;
    const t = new Date(now + THIRTY + 1).toISOString();
    const r = NearTime.classifyTime(t, now, THIRTY);
    assert.strictEqual(r.kind, 'future');
    assert.strictEqual(r.needsConfirm, false);
  });
});

describe('NearTime.summarizeNearTimes', () => {
  const now = new Date('2026-10-27T14:00:00Z').getTime();
  const THIRTY = 30 * 60 * 1000;

  it('空数组 → count=0, earliestMs=NaN', () => {
    const r = NearTime.summarizeNearTimes([], now, THIRTY);
    assert.strictEqual(r.count, 0);
    assert.ok(isNaN(r.earliestMs));
    assert.strictEqual(r.invalidCount, 0);
  });

  it('混合：1 条过去、1 条临近、1 条未来、1 条非法', () => {
    const times = [
      new Date(now - 1000).toISOString(),       // past
      new Date(now + 15 * 60 * 1000).toISOString(), // near (15 min)
      new Date(now + 60 * 60 * 1000).toISOString(), // future (60 min)
      'invalid-date'
    ];
    const r = NearTime.summarizeNearTimes(times, now, THIRTY);
    assert.strictEqual(r.count, 2); // past + near
    assert.strictEqual(r.invalidCount, 1);
    // earliestMs 应该是过去那条（now - 1000）
    assert.strictEqual(r.earliestMs, now - 1000);
  });

  it('所有项都在未来（>30 分钟）→ count=0', () => {
    const times = [
      new Date(now + 40 * 60 * 1000).toISOString(),
      new Date(now + 50 * 60 * 1000).toISOString()
    ];
    const r = NearTime.summarizeNearTimes(times, now, THIRTY);
    assert.strictEqual(r.count, 0);
    assert.ok(isNaN(r.earliestMs));
  });

  it('只有非法项 → count=0, invalidCount>0', () => {
    const r = NearTime.summarizeNearTimes(['bad', 'also bad'], now, THIRTY);
    assert.strictEqual(r.count, 0);
    assert.strictEqual(r.invalidCount, 2);
  });

  it('恰好 30 分钟（边界）→ count=1', () => {
    const t = new Date(now + THIRTY).toISOString();
    const r = NearTime.summarizeNearTimes([t], now, THIRTY);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.earliestMs, now + THIRTY);
  });

  it('不同时区表示的同一瞬间 → earliestMs 一致', () => {
    const utc = new Date(now).toISOString();
    const local = new Date(now).toString();
    const r = NearTime.summarizeNearTimes([utc, local], now, THIRTY);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.earliestMs, now);
  });
});

describe('NearTime.formatLocalTime', () => {
  it('有效 epoch → YYYY-MM-DD HH:mm', () => {
    const ms = new Date('2026-10-27T14:35:00Z').getTime();
    const s = NearTime.formatLocalTime(ms);
    // 本地时区可能不同，只验证格式
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s));
  });

  it('非法输入（NaN）→ 空串', () => {
    assert.strictEqual(NearTime.formatLocalTime(NaN), '');
  });

  it('非数字输入 → 空串', () => {
    assert.strictEqual(NearTime.formatLocalTime('not a number'), '');
  });

  it('undefined → 空串', () => {
    assert.strictEqual(NearTime.formatLocalTime(undefined), '');
  });
});

describe('NearTime 常量导出', () => {
  it('RELEASE_NEAR_MS = 10 * 60 * 1000', () => {
    assert.strictEqual(NearTime.RELEASE_NEAR_MS, 10 * 60 * 1000);
  });

  it('BATCH_NEAR_MS = 30 * 60 * 1000', () => {
    assert.strictEqual(NearTime.BATCH_NEAR_MS, 30 * 60 * 1000);
  });
});
