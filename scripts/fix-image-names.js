#!/usr/bin/env node
'use strict';
/**
 * 存量文件名乱码修复脚本（latin1→utf8 mojibake）。
 *
 * 用法：
 *   node scripts/fix-image-names.js            # 默认 dry-run：只打印
 *   node scripts/fix-image-names.js --apply    # 实际写入 db.json
 *   DATA_DIR=... node scripts/fix-image-names.js
 *
 * --apply 时先把 db.json 备份为 db.json.bak-names-<ts>，再同时修
 * images[].name 与 jobs[].images[].name 快照。
 */
const fs = require('fs');
const path = require('path');
const { decodeMojibakeName } = require('../src/filename');

const apply = process.argv.includes('--apply');
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbFile = path.join(dataDir, 'db.json');

function main() {
  if (!fs.existsSync(dbFile)) {
    console.error(`找不到数据文件: ${dbFile}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(dbFile, 'utf8');
  const db = JSON.parse(raw.replace(/^\uFEFF/, ''));
  const fixes = []; // { where, key, before, after }

  for (const img of Array.isArray(db.images) ? db.images : []) {
    const after = decodeMojibakeName(img.name);
    if (after !== img.name) fixes.push({ where: 'images', key: img.key, before: img.name, after });
  }
  for (const job of Array.isArray(db.jobs) ? db.jobs : []) {
    let changed = false;
    const newImages = (job.images || []).map((i) => {
      const after = decodeMojibakeName(i.name);
      if (after !== i.name) {
        changed = true;
        fixes.push({ where: `jobs[${job.id}].images`, key: i.key, before: i.name, after });
        return { ...i, name: after };
      }
      return i;
    });
    if (changed) job.images = newImages;
  }

  console.log(`数据文件: ${dbFile}`);
  console.log(`图片总数: ${(db.images || []).length}，任务总数: ${(db.jobs || []).length}`);
  console.log(`可修复条数: ${fixes.length}`);
  for (const f of fixes.slice(0, 10)) {
    console.log(`  [${f.where}] ${f.key}\n    before: ${JSON.stringify(f.before)}\n    after : ${JSON.stringify(f.after)}`);
  }
  if (fixes.length > 10) console.log(`  … 以及另外 ${fixes.length - 10} 条`);

  if (!apply) {
    console.log('\n(dry-run：未写入。加 --apply 执行修复)');
    return;
  }
  if (!fixes.length) {
    console.log('\n没有需要修复的条目，未写入。');
    return;
  }
  // 写前备份
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${dbFile}.bak-names-${ts}`;
  fs.copyFileSync(dbFile, bak);
  console.log(`\n已备份: ${bak}`);
  for (const img of db.images) {
    const after = decodeMojibakeName(img.name);
    if (after !== img.name) img.name = after;
  }
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), 'utf8');
  console.log(`已写入修复结果到: ${dbFile}`);
}

main();
