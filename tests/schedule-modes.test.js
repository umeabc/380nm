const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../public/js/schedule.js'), 'utf8'), ctx);
const { plan } = ctx.window.BatchSchedule;
const base = { N: 3, date: '2026-10-12', start: '10:02', end: '11:00', avoid: [] };
test('interval starts at window start and crosses hours at exact integer intervals', () => {
  const result = plan({ ...base, intervalMinutes: 17 });
  assert.equal(result.slots.map(s => s.time).join(','), '10:02,10:19,10:36');
  assert.equal(result.slots[0].title, '「10-12 10:02」');
});
test('minute tail 5 recurs every ten minutes across an hour, not once per hour', () => {
  const result = plan({ ...base, N: 7, end: '11:05', scheduleMode: 'minute-tail', minuteTail: 5 });
  assert.equal(result.slots.map(s => s.time).join(','), '10:05,10:15,10:25,10:35,10:45,10:55,11:05');
});
test('minute tail zero includes eligible end boundary and respects after', () => {
  const after = new Date(2026, 9, 12, 10, 10).getTime();
  const result = plan({ ...base, scheduleMode: 'minute-tail', minuteTail: 0, after });
  assert.equal(result.slots.map(s => s.time).join(','), '10:20,10:30,10:40');
});
test('invalid intervals, tail, date, and clock values are rejected', () => {
  for (const intervalMinutes of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => plan({ ...base, intervalMinutes }));
  for (const minuteTail of [-1, 10, 2.5, NaN]) assert.throws(() => plan({ ...base, scheduleMode: 'minute-tail', minuteTail }));
  assert.throws(() => plan({ ...base, date: '2026-02-31' }));
  assert.throws(() => plan({ ...base, start: '10:61' }));
});
test('capacity uses minute candidates instead of hours', () => {
  assert.throws(() => plan({ ...base, N: 7, scheduleMode: 'minute-tail', minuteTail: 5 }), /少于 7 条/);
});
