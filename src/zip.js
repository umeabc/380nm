'use strict';
/* 极简 ZIP 打包（store 模式，不压缩——图片本身已是压缩格式）+ 安全解包，零依赖 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/** entries: [{ name: 'a.jpg', buffer: Buffer, mtime?: Date }] → Buffer */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(String(e.name || 'file'), 'utf8');
    const data = Buffer.isBuffer(e.buffer) ? e.buffer : Buffer.from(e.buffer);
    const crc = crc32(data);
    const { time, date } = dosDateTime(e.mtime || new Date());

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // UTF-8 文件名
    lh.writeUInt16LE(0, 8);         // method: store
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    localParts.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);        // version made by
    ch.writeUInt16LE(20, 6);        // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, central, eocd]);
}

module.exports = { buildZip };

/* ===================== 安全解包 =====================
 * 从 EOCD 定位中央目录，逐条核对 local header 与方法、名称、CRC、实际长度；
 * 仅支持 store(0) 与 deflate(8)；拒绝 ZIP64 / 多卷 / 加密 / 符号链接 / 危险路径。
 * 返回 [{ name, buffer, isDir }]；任何不一致直接抛错（不产出残缺数据）。
 */

class ZipError extends Error {
  constructor(message) { super(message); this.name = 'ZipError'; }
}

function findEocd(buf) {
  if (buf.length < 22) throw new ZipError('不是有效的 zip 文件（太短）');
  // EOCD 签名 0x06054b50，从尾部往前找，跳过最多 64KB 注释
  const min = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ZipError('找不到 zip 结束目录（EOCD）');
}

/**
 * 安全解压 zip。
 * limits: { maxEntries, maxTotalBytes, maxFileBytes }
 * 每个条目都做：local header 签名/方法/名称/CRC/长度核对；
 * deflate 用 inflateRawSync({ maxOutputLength }) 防炸弹。
 */
function unzip(buf, limits = {}) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const maxEntries = limits.maxEntries || 2000;
  if (maxEntries <= 0) throw new ZipError(`zip 条目数超过上限（${maxEntries}）`);
  const maxTotalBytes = limits.maxTotalBytes || 200 * 1024 * 1024;
  const maxFileBytes = limits.maxFileBytes || 100 * 1024 * 1024;
  const eocd = findEocd(buf);
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipError('不支持多卷 zip 文件');
  }
  const count = buf.readUInt16LE(eocd + 10);
  if (count === 0xFFFF) throw new ZipError('不支持 ZIP64 格式');
  if (count > maxEntries) throw new ZipError(`zip 条目数超过上限（${maxEntries}）`);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (centralSize === 0xFFFFFFFF || centralOffset === 0xFFFFFFFF) {
    throw new ZipError('不支持 ZIP64 格式');
  }
  if (centralOffset + centralSize > buf.length) throw new ZipError('zip 中央目录越界');

  const entries = [];
  let total = 0;
  let p = centralOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new ZipError('zip 中央目录损坏');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF ||
        crc === 0xFFFFFFFF) {
      throw new ZipError('不支持 ZIP64 格式');
    }
    if (flags & 0x0001) throw new ZipError('不支持加密 zip 条目');
    if (flags & 0x0008) throw new ZipError('不支持数据描述符（bit3）条目');
    const nameBuf = buf.slice(p + 46, p + 46 + nameLen);
    if (nameBuf.length !== nameLen) throw new ZipError('zip 条目名越界');
    // 名称必须是 UTF-8（标志位）或纯 ASCII，否则明确报编码不支持（不猜 GBK）
    const name = nameBuf.toString('utf8');
    if (!(flags & 0x0800)) {
      for (let i = 0; i < nameBuf.length; i++) {
        if (nameBuf[i] > 0x7F) throw new ZipError('文件名编码不支持（缺少 UTF-8 标志且含非 ASCII 字符）');
      }
    }
    // 危险路径：反斜杠、绝对路径、盘符、..
    if (name.includes('\\')) throw new ZipError(`非法条目路径: ${name}`);
    if (/^[a-zA-Z]:/.test(name) || name.startsWith('/')) throw new ZipError(`非法条目路径: ${name}`);
    const normSegs = name.split('/').filter(s => s !== '' && s !== '.');
    if (normSegs.some(s => s === '..')) throw new ZipError(`非法条目路径: ${name}`);
    const isDir = name.endsWith('/');
    // 目录条目规范化名保留尾斜杠（images/）
    const norm = isDir ? normSegs.join('/') + '/' : normSegs.join('/');
    // 符号链接（unix attr 高 16 位 mode & 0xF000 === 0xA000）
    if (!isDir && ((attr >>> 16) & 0xF000) === 0xA000) throw new ZipError('不支持 zip 内的符号链接');

    // local header 核对
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ZipError(`条目 ${norm} 的 local header 损坏`);
    }
    const lMethod = buf.readUInt16LE(localOffset + 8);
    const lCrc = buf.readUInt32LE(localOffset + 14);
    const lComp = buf.readUInt32LE(localOffset + 18);
    const lUncomp = buf.readUInt32LE(localOffset + 22);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    if (lMethod !== method) throw new ZipError(`条目 ${norm} 的压缩方法与中央目录不一致`);
    if (lCrc !== crc || lComp !== compSize || lUncomp !== uncompSize) {
      throw new ZipError(`条目 ${norm} 的头部信息与中央目录不一致`);
    }
    const lName = buf.slice(localOffset + 30, localOffset + 30 + lNameLen);
    if (Buffer.compare(lName, nameBuf) !== 0) throw new ZipError(`条目 ${norm} 的名称与中央目录不一致`);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) throw new ZipError(`条目 ${norm} 的数据越界`);

    if (method !== 0 && method !== 8) throw new ZipError(`条目 ${norm} 使用不支持的压缩方法 ${method}`);

    let data;
    if (isDir) {
      if (compSize !== 0) throw new ZipError(`目录条目 ${norm} 不应包含数据`);
      entries.push({ name: norm, buffer: Buffer.alloc(0), isDir: true, rawName: name });
      p += 46 + nameLen + extraLen + commentLen;
      continue;
    }
    if (uncompSize > maxFileBytes) throw new ZipError(`条目 ${norm} 超过单文件大小上限`);
    if (total + uncompSize > maxTotalBytes) throw new ZipError('解压后总大小超过上限');
    const comp = buf.slice(dataStart, dataStart + compSize);
    if (method === 0) {
      if (comp.length !== uncompSize) throw new ZipError(`条目 ${norm} 的 store 长度与声明不一致`);
      data = comp;
    } else {
      try {
        data = zlib.inflateRawSync(comp, { maxOutputLength: uncompSize > 0 ? uncompSize : maxTotalBytes });
      } catch (e) {
        throw new ZipError(`条目 ${norm} 解压失败: ${e.message}`);
      }
    }
    if (data.length !== uncompSize) throw new ZipError(`条目 ${norm} 解压后长度与声明不一致`);
    if (crc32(data) !== crc) throw new ZipError(`条目 ${norm} 的 CRC 校验失败`);
    total += data.length;
    entries.push({ name: norm, buffer: data, isDir: false, rawName: name });
    p += 46 + nameLen + extraLen + commentLen;
  }
  // 规范化后重复路径
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.name)) throw new ZipError(`重复条目路径: ${e.name}`);
    seen.add(e.name);
  }
  return entries;
}

module.exports = { buildZip, unzip, ZipError, crc32 };
