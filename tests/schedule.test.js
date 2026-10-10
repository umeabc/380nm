/* 测试：批量编排排期算法 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');

// 在隔离的 VM 中加载 schedule.js
const code = fs.readFileSync(path.join(__dirname, '../public/js/schedule.js'), 'utf8');
const context = { window: {} };
vm.createContext(context);
vm.runInContext(code, context);
const { plan } = context.window.BatchSchedule;

describe('BatchSchedule.plan', () => {
  it('严格避让成功：N=3, 窗口10-20, 默认避让11/13/17/19 → 14/15/16', () => {
    const result = plan({
      N: 3,
      date: '2026-10-12',
      start: '10:00',
      end: '20:00',
      avoid: [11, 13, 17, 19],
      prefix: '优香'
    });
    assert.strictEqual(result.relaxed, false);
    const hours = result.slots.map(s => s.hour);
    assert.strictEqual(JSON.stringify(hours), JSON.stringify([14, 15, 16]));
    assert.strictEqual(result.conflicts.length, 0);
    result.slots.forEach((s, i) => {
      assert.strictEqual(s.time, `${14 + i}:00`);
      assert.match(s.scheduledAt, /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.\d{3}Z$/);
      assert.strictEqual(s.title, `「优香 10-12 ${14 + i}:00」`);
    });
  });

  it('无避让：N=3, 窗口10-20, avoid=[] → 10/11/12', () => {
    const result = plan({
      N: 3,
      date: '2026-10-12',
      start: '10:00',
      end: '20:00',
      avoid: [],
      prefix: '优香'
    });
    assert.strictEqual(result.relaxed, false);
    const hours = result.slots.map(s => s.hour);
    assert.strictEqual(JSON.stringify(hours), JSON.stringify([10, 11, 12]));
  });

  it('放宽避让：窗口10-17, N=6, 避让11/13/17/19 → 10-15, conflicts包含11/13', () => {
    const result = plan({
      N: 6,
      date: '2026-10-12',
      start: '10:00',
      end: '17:00',
      avoid: [11, 13, 17, 19],
      prefix: '优香'
    });
    assert.strictEqual(result.relaxed, true);
    const hours = result.slots.map(s => s.hour);
    assert.strictEqual(JSON.stringify(hours), JSON.stringify([10, 11, 12, 13, 14, 15]));
    assert.strictEqual(JSON.stringify(result.conflicts), JSON.stringify(['11:00', '13:00']));
  });

  it('容量不足：N=4, 窗口10-12（3个整点）→ 抛出错误', () => {
    assert.throws(() => {
      plan({
        N: 4,
        date: '2026-10-12',
        start: '10:00',
        end: '12:00',
        avoid: [],
        prefix: '优香'
      });
    }, /时间窗仅 3 个整点，少于 4 条/);
  });

  it('N=0 → 抛出错误', () => {
    assert.throws(() => {
      plan({
        N: 0,
        date: '2026-10-12',
        start: '10:00',
        end: '20:00',
        avoid: [],
        prefix: '优香'
      });
    }, /请先录入作品链接/);
  });

  it('N=1 单条 → 取窗口第一个整点', () => {
    const result = plan({
      N: 1,
      date: '2026-10-12',
      start: '15:00',
      end: '20:00',
      avoid: [],
      prefix: '优香'
    });
    assert.strictEqual(result.slots.length, 1);
    assert.strictEqual(result.slots[0].hour, 15);
  });

  it('全避让：窗口10-12, 避让10/11/12, N=2 → 放宽取最少', () => {
    const result = plan({
      N: 2,
      date: '2026-10-12',
      start: '10:00',
      end: '12:00',
      avoid: [10, 11, 12],
      prefix: '优香'
    });
    assert.strictEqual(result.relaxed, true);
    const hours = result.slots.map(s => s.hour);
    assert.strictEqual(JSON.stringify(hours), JSON.stringify([10, 11]));
    assert.strictEqual(result.conflicts.length, 2);
  });

  it('结束时间早于开始 → 抛出错误', () => {
    assert.throws(() => {
      plan({
        N: 2,
        date: '2026-10-12',
        start: '20:00',
        end: '10:00',
        avoid: [],
        prefix: '优香'
      });
    }, /结束时间必须晚于开始时间/);
  });

  it('标题超长 → 抛出错误', () => {
    assert.throws(() => {
      plan({
        N: 1,
        date: '2026-10-12',
        start: '10:00',
        end: '20:00',
        avoid: [],
        prefix: '这是一个非常非常非常长的前缀'
      });
    }, /标题.*超过20字/);
  });

  it('UTC时区转换：Asia/Shanghai UTC+8, 本地10:00 → 02:00Z', () => {
    const result = plan({
      N: 1,
      date: '2026-10-12',
      start: '10:00',
      end: '10:00',
      avoid: [],
      prefix: '优香'
    });
    // 本地 2026-10-12 10:00 在 UTC+8 应该是 02:00 UTC
    assert.match(result.slots[0].scheduledAt, /2026-10-12T02:00:00/);
  });

  it('输入不变性：多次调用相同输入得到相同输出', () => {
    const cfg = {
      N: 3,
      date: '2026-10-12',
      start: '10:00',
      end: '20:00',
      avoid: [11, 13],
      prefix: '优香'
    };
    const r1 = plan(cfg);
    const r2 = plan(cfg);
    assert.deepStrictEqual(r1, r2);
  });

  it('窗口边界：start=end → 1个整点', () => {
    const result = plan({
      N: 1,
      date: '2026-10-12',
      start: '14:00',
      end: '14:00',
      avoid: [],
      prefix: '优香'
    });
    assert.strictEqual(result.slots.length, 1);
    assert.strictEqual(result.slots[0].hour, 14);
  });

  it('平局保留最早：窗口10-15, N=3, 避让12/14 → 10-12（命中12）vs 11-13（命中12）vs 13-15（命中14）→ 10-12', () => {
    const result = plan({
      N: 3,
      date: '2026-10-12',
      start: '10:00',
      end: '15:00',
      avoid: [12, 14],
      prefix: '优香'
    });
    assert.strictEqual(result.relaxed, true);
    // 10-12 和 11-13 都命中1个，应选最早的 10-12
    const hours = result.slots.map(s => s.hour);
    assert.strictEqual(JSON.stringify(hours), JSON.stringify([10, 11, 12]));
    assert.strictEqual(JSON.stringify(result.conflicts), JSON.stringify(['12:00']));
  });
});
