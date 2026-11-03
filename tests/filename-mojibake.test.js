/* 测试：上传文件名乱码修复（latin1→utf8 mojibake） */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { decodeMojibakeName } = require('../src/filename');

describe('decodeMojibakeName', () => {
  it('真乱码可还原：测试.jpg', () => {
    const good = '测试.jpg';
    const moji = Buffer.from(good, 'utf8').toString('latin1');
    assert.strictEqual(decodeMojibakeName(moji), good);
  });

  it('真乱码可还原：日文与全角混合', () => {
    const good = 'ファイル ①.png';
    const moji = Buffer.from(good, 'utf8').toString('latin1');
    assert.strictEqual(decodeMojibakeName(moji), good);
  });

  it('Ã© 这类真名不误改（解码后无非拉丁字符）', () => {
    // "café.jpg" 经 latin1 误解会得到 "café.jpg"（é 单字符），但不满足
    // “解码后出现非拉丁字符”门槛 → 原样返回
    const name = 'cafÃ©.jpg'; // 一个真的叫 cafÃ©.jpg 的文件
    assert.strictEqual(decodeMojibakeName(name), name);
  });

  it('纯 ASCII 不动', () => {
    assert.strictEqual(decodeMojibakeName('photo_2024.jpg'), 'photo_2024.jpg');
    assert.strictEqual(decodeMojibakeName(''), '');
  });

  it('含 U+FFFD 解码失败 → 原样', () => {
    // 0x80 开头但不是合法 UTF-8 序列
    assert.strictEqual(decodeMojibakeName('\x80\x81.jpg'), '\x80\x81.jpg');
  });

  it('超出 latin1 范围（已是正常中文名）→ 原样', () => {
    assert.strictEqual(decodeMojibakeName('测试.jpg'), '测试.jpg');
  });
});

describe('scripts/fix-image-names.js', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fixnames-'));
  const dbFile = path.join(tmp, 'db.json');

  it('dry-run 打印统计且不写入；--apply 修复 images 与 jobs 快照并备份', () => {
    const moji = Buffer.from('测试图片.jpg', 'utf8').toString('latin1');
    const db = {
      images: [
        { key: 'img1', name: moji },
        { key: 'img2', name: 'normal.jpg' }
      ],
      jobs: [{ id: 'job1', images: [{ key: 'img1', name: moji, url: '/u' }] }]
    };
    fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));

    const run = (args) => execFileSync(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'fix-image-names.js'), ...args],
      { env: { ...process.env, DATA_DIR: tmp }, encoding: 'utf8' });

    // dry-run：不写
    const dry = run([]);
    assert.match(dry, /可修复条数: 2/);
    assert.match(dry, /dry-run/);
    assert.strictEqual(JSON.parse(fs.readFileSync(dbFile, 'utf8')).images[0].name, moji);

    // --apply：写 + 备份 + jobs 快照同步
    const out = run(['--apply']);
    assert.match(out, /已备份/);
    const baks = fs.readdirSync(tmp).filter(f => f.startsWith('db.json.bak-names-'));
    assert.strictEqual(baks.length, 1);
    const after = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
    assert.strictEqual(after.images[0].name, '测试图片.jpg');
    assert.strictEqual(after.images[1].name, 'normal.jpg');
    assert.strictEqual(after.jobs[0].images[0].name, '测试图片.jpg');
    assert.strictEqual(after.jobs[0].images[0].url, '/u');
  });

  it('无可修复时 --apply 不写不备份', () => {
    const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fixnames2-'));
    fs.writeFileSync(path.join(t2, 'db.json'), JSON.stringify({
      images: [{ key: 'a', name: 'ok.jpg' }], jobs: []
    }));
    const out = execFileSync(process.execPath,
      [path.join(__dirname, '..', 'scripts', 'fix-image-names.js'), '--apply'],
      { env: { ...process.env, DATA_DIR: t2 }, encoding: 'utf8' });
    assert.match(out, /可修复条数: 0/);
    assert.match(out, /没有需要修复/);
    assert.strictEqual(fs.readdirSync(t2).filter(f => f.includes('bak')).length, 0);
  });
});
