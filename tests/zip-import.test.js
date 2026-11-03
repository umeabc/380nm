/* 测试：zip 解压安全（store/deflate、CRC、路径穿越、炸弹、UTF-8 标志） */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { buildZip, unzip, ZipError, crc32 } = require('../src/zip');

/** 手工构造一个 zip（可定制方法、标志、CRC 等），返回 Buffer */
function makeZip(entries) {
  // entries: [{ name, data, method (0|8), flags, crc }]
  const local = [], central = [];
  let offset = 0;
  const nb = (s) => Buffer.from(s, 'utf8');
  for (const e of entries) {
    const nameBuf = nb(e.name);
    const method = e.method || 0;
    const flags = e.flags == null ? 0x0800 : e.flags;
    const data = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const crc = e.crc == null ? crc32(e.data) : e.crc;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const c = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(c.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, c, eocd]);
}

describe('unzip', () => {
  it('store 条目解压成功', () => {
    const zip = makeZip([{ name: 'a.txt', data: Buffer.from('hello store') }]);
    const es = unzip(zip);
    assert.strictEqual(es.length, 1);
    assert.strictEqual(es[0].name, 'a.txt');
    assert.strictEqual(es[0].buffer.toString(), 'hello store');
  });

  it('deflate 条目解压成功', () => {
    const big = Buffer.from('compress me '.repeat(100));
    const zip = makeZip([{ name: 'b.txt', data: big, method: 8 }]);
    const es = unzip(zip);
    assert.strictEqual(es[0].buffer.toString(), big.toString());
  });

  it('buildZip → unzip 往返', () => {
    const zip = buildZip([
      { name: 'queue.csv', buffer: Buffer.from('a,b') },
      { name: 'images/图片.jpg', buffer: Buffer.from([0xFF, 0xD8, 0xFF, 0x00]) }
    ]);
    const es = unzip(zip);
    assert.deepStrictEqual(es.map(e => e.name), ['queue.csv', 'images/图片.jpg']);
  });

  it('CRC 错误 → 拒绝', () => {
    const zip = makeZip([{ name: 'a.txt', data: Buffer.from('hello'), crc: 0xdeadbeef }]);
    assert.throws(() => unzip(zip), /CRC 校验失败/);
  });

  it('local header 方法不一致 → 拒绝', () => {
    const zip = makeZip([{ name: 'a.txt', data: Buffer.from('hello'), method: 8 }]);
    // 中央目录说 deflate、local 实际也是 deflate；这里直接破坏 local 方法字节
    const broken = Buffer.from(zip);
    broken.writeUInt16LE(0, 30 + 8); // 第一个 local header 的 method 改成 0
    assert.throws(() => unzip(broken), /不一致|不支持的压缩方法|解压/);
  });

  it('路径穿越 ../ → 拒绝', () => {
    const zip = makeZip([{ name: '../evil.txt', data: Buffer.from('x') }]);
    assert.throws(() => unzip(zip), /非法条目路径/);
  });

  it('绝对路径 / 盘符 → 拒绝', () => {
    assert.throws(() => unzip(makeZip([{ name: '/etc/passwd', data: Buffer.from('x') }])), /非法条目路径/);
    assert.throws(() => unzip(makeZip([{ name: 'C:/x.txt', data: Buffer.from('x') }])), /非法条目路径/);
  });

  it('反斜杠路径 → 拒绝', () => {
    const zip = makeZip([{ name: 'dir\\evil.txt', data: Buffer.from('x') }]);
    assert.throws(() => unzip(zip), /非法条目路径/);
  });

  it('加密条目 → 拒绝', () => {
    const zip = makeZip([{ name: 'a.txt', data: Buffer.from('x'), flags: 0x0801 }]);
    assert.throws(() => unzip(zip), /不支持加密/);
  });

  it('非 ASCII 名称且无 UTF-8 标志 → 明确报编码不支持', () => {
    const zip = makeZip([{ name: '图片.jpg', data: Buffer.from('x'), flags: 0 }]);
    assert.throws(() => unzip(zip), /文件名编码不支持/);
  });

  it('ASCII 名称无 UTF-8 标志 → 放行', () => {
    const zip = makeZip([{ name: 'ascii.txt', data: Buffer.from('x'), flags: 0 }]);
    const es = unzip(zip);
    assert.strictEqual(es[0].name, 'ascii.txt');
  });

  it('重复路径 → 拒绝', () => {
    const zip = Buffer.concat([
      makeZip([{ name: 'a.txt', data: Buffer.from('x') }]),
      makeZip([{ name: 'a.txt', data: Buffer.from('y') }])
    ]);
    // 构造一个真正含重复条目的 zip：手工拼两个同名的
    const one = makeZip([{ name: 'a.txt', data: Buffer.from('x') }]);
    assert.throws(() => {
      // 重算 EOCD：取两个单条 zip 合并（简化：直接用 makeZip 支持 entries 重复名）
      const dup = makeZip([{ name: 'a.txt', data: Buffer.from('x') }, { name: 'a.txt', data: Buffer.from('y') }]);
      unzip(dup);
    }, /重复条目路径/);
  });

  it('条目数超上限 → 拒绝', () => {
    const zip = makeZip([
      { name: 'a.txt', data: Buffer.from('x') },
      { name: 'b.txt', data: Buffer.from('y') }
    ]);
    assert.throws(() => unzip(zip, { maxEntries: 1 }), /条目数超过上限/);
  });

  it('解压总量超上限 → 拒绝（炸弹兜底）', () => {
    const big = Buffer.alloc(1024, 0x41);
    const zip = makeZip([{ name: 'a.bin', data: big, method: 8 }]);
    assert.throws(() => unzip(zip, { maxTotalBytes: 100 }), /解压后总大小超过上限/);
  });

  it('deflate 声明长度与实际不一致 → 拒绝', () => {
    // 声明 uncompSize 很大，实际很小 → maxOutputLength 兜底失败
    const comp = zlib.deflateRawSync(Buffer.from('tiny'));
    const entries = [{ name: 'a.bin', data: Buffer.from('tiny'), method: 8 }];
    // 手工：把中央目录与 local 的 uncompSize 改大
    const zip = makeZip(entries);
    const broken = Buffer.from(zip);
    // central directory 开始位置：local 30+name+comp
    const lNameLen = broken.readUInt16LE(26);
    const compSize = broken.readUInt32LE(18);
    const cdOff = 30 + lNameLen + compSize;
    broken.writeUInt32LE(0x00FFFFFF, cdOff + 24); // central uncompSize
    broken.writeUInt32LE(0x00FFFFFF, 22); // local uncompSize
    assert.throws(() => unzip(broken), /解压失败|长度与声明不一致/);
  });

  it('非 zip 数据 → 拒绝', () => {
    assert.throws(() => unzip(Buffer.from('not a zip at all........')), /EOCD|zip/);
  });
});
