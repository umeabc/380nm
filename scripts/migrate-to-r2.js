#!/usr/bin/env node
/**
 * 本地图库 → Cloudflare R2 迁移
 *
 * 设计要点：
 *   1. 上传时**保留原 key 不变**（如 202609/xxx.jpg）。发布链路用的是 storage.get(key)，
 *      key 不变意味着调度器/发布逻辑无需任何改动。
 *   2. 只改写 db.json 里的 `url` 字段（/uploads/<key> → <R2_PUBLIC_BASE>/<key>），
 *      前端全部用 img.url 渲染，所以前端也无需改动。
 *   3. 本地文件保留不删，可随时回滚。
 *
 * ⚠️ 必须在**应用停止**时执行！
 *    应用把 db.json 全量读入内存，并会在任意一次 save() 时把内存数据整体回写。
 *    若应用仍在运行，本脚本改写完 db.json 后会被应用的下一次保存覆盖回旧值
 *    （url 退回 /uploads/...），且不会有任何报错。
 *
 * 正确用法（注意先 down，再用 run 起一次性容器）：
 *   cd /opt/bili-dyn-publisher
 *   docker compose down
 *   docker compose run --rm --no-deps bili-dyn node scripts/migrate-to-r2.js --dry-run
 *   docker compose run --rm --no-deps bili-dyn node scripts/migrate-to-r2.js --verify
 *   docker compose up -d
 *
 * 环境变量：R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET / R2_PUBLIC_BASE
 */
const fsp = require('fs/promises');
const path = require('path');
const { config } = require('../src/config');

const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif'
};

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERIFY = argv.includes('--verify');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

/** 递归列出目录下全部文件，key 用 posix 分隔符（S3 规范） */
async function walk(dir, base, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return out;
    throw e;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(full, base, out);
    else if (ent.isFile()) out.push({ full, key: path.relative(base, full).split(path.sep).join('/') });
  }
  return out;
}

/** 判断 url 是否仍指向本地存储 */
const isLocalUrl = (u) => !u || String(u).startsWith('/uploads/');

function main() {
  return (async () => {
    const r2 = config.storage.r2;
    const missing = ['accountId', 'accessKeyId', 'secretAccessKey', 'bucket'].filter((k) => !r2[k]);
    if (missing.length) {
      warn('✗ R2 配置不完整，缺少环境变量: ' + missing.map((k) => 'R2_' + k.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()).join(', '));
      process.exit(1);
    }
    const publicBase = String(r2.publicBase || '').replace(/\/+$/, '');
    if (!publicBase) {
      warn('! 未配置 R2_PUBLIC_BASE —— 前端将无法预览图片（url 只写入 key）');
    }

    const { R2Storage } = require('../src/storage/r2');
    const storage = await R2Storage.create(r2);

    const dbPath = path.join(config.dataDir, 'db.json');
    const uploadsDir = path.join(config.dataDir, 'uploads');

    log('=== 迁移配置 ===');
    log('  数据目录   :', config.dataDir);
    log('  本地图库   :', uploadsDir);
    log('  R2 桶      :', r2.bucket);
    log('  R2 账户    :', r2.accountId);
    log('  公网前缀   :', publicBase || '(未配置)');
    log('  模式       :', DRY ? 'DRY-RUN（不写入）' : '实际执行');
    if (!DRY) {
      warn('  ⚠ 请确认应用已停止（docker compose down）。应用运行中会把内存里的旧数据回写，覆盖本次改写。');
    }

    let db;
    try {
      db = JSON.parse((await fsp.readFile(dbPath, 'utf8')).replace(/^﻿/, ''));
    } catch (e) {
      warn('✗ 无法读取 db.json:', e.message);
      process.exit(1);
    }

    // ---------- 1. 上传本地文件 ----------
    const files = await walk(uploadsDir, uploadsDir);
    log(`\n=== [1/3] 上传本地文件（${files.length} 个）===`);
    let uploaded = 0;
    const failed = [];
    for (const f of files) {
      const ext = path.extname(f.full).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      if (DRY) {
        log(`  [dry] ${f.key}  (${contentType})`);
        continue;
      }
      try {
        const buf = await fsp.readFile(f.full);
        // 保留原 key：直接 PutObject，不走 storage.put()（它会生成新 key）
        const { PutObjectCommand } = require('@aws-sdk/client-s3');
        await storage.client.send(
          new PutObjectCommand({ Bucket: r2.bucket, Key: f.key, Body: buf, ContentType: contentType })
        );
        uploaded++;
        log(`  ✓ ${f.key}  ${(buf.length / 1024).toFixed(1)} KB`);
      } catch (e) {
        failed.push({ key: f.key, error: e.message });
        warn(`  ✗ ${f.key}  ${e.message}`);
      }
    }
    if (failed.length) {
      warn(`\n✗ 有 ${failed.length} 个文件上传失败，中止以避免数据不一致。请修复后重试。`);
      process.exit(1);
    }

    // ---------- 2. 改写 db.json 中的 url ----------
    log('\n=== [2/3] 改写 db.json 中的 url ===');
    const localKeys = new Set(files.map((f) => f.key));
    let rewritten = 0;
    let orphanRecords = 0;
    const touched = [];

    const rewrite = (rec, where) => {
      if (!rec || !rec.key) return;
      if (!isLocalUrl(rec.url)) return; // 已是 R2 url，跳过（幂等）
      const old = rec.url;
      rec.url = publicBase ? `${publicBase}/${rec.key}` : rec.key;
      rewritten++;
      if (!localKeys.has(rec.key)) {
        orphanRecords++;
        warn(`  ! ${where} key=${rec.key} 在本地图库中不存在（url 已改写，但需确认 R2 上有该对象）`);
      }
      touched.push({ where, key: rec.key, from: old, to: rec.url });
    };

    (db.images || []).forEach((img, i) => rewrite(img, `images[${i}]`));
    (db.jobs || []).forEach((job, ji) => {
      (job.images || []).forEach((it, ii) => rewrite(it, `jobs[${ji}].images[${ii}]`));
    });

    log(`  图库记录   : ${(db.images || []).length}`);
    log(`  任务快照   : ${(db.jobs || []).reduce((n, j) => n + (j.images || []).length, 0)}`);
    log(`  改写 url   : ${rewritten}`);
    if (orphanRecords) log(`  本地缺失   : ${orphanRecords}（见上方警告）`);
    touched.slice(0, 10).forEach((t) => log(`    ${t.where}  ${t.from} → ${t.to}`));
    if (touched.length > 10) log(`    ... 另有 ${touched.length - 10} 条`);

    if (DRY) {
      log('\n(dry-run 结束，未写入任何内容)');
      return;
    }

    // ---------- 3. 备份并原子写入 ----------
    log('\n=== [3/3] 写入 db.json ===');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${dbPath}.bak-r2-${stamp}`;
    await fsp.copyFile(dbPath, backup);
    log(`  备份: ${backup}`);

    const tmp = `${dbPath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2), 'utf8');
    await fsp.rename(tmp, dbPath);
    log('  ✓ 已写入');

    // ---------- 校验 ----------
    if (VERIFY && publicBase) {
      log('\n=== 校验公网可访问性 ===');
      let ok = 0;
      for (const t of touched) {
        const url = `${publicBase}/${t.key}`;
        try {
          const res = await fetch(url);
          if (res.ok) { ok++; log(`  ✓ ${res.status} ${url}`); }
          else warn(`  ✗ ${res.status} ${url}`);
        } catch (e) {
          warn(`  ✗ ${e.message} ${url}`);
        }
      }
      log(`  通过 ${ok}/${touched.length}`);
    }

    // 发布链路校验：确认 storage.get(key) 能取回对象
    log('\n=== 校验发布链路 storage.get(key) ===');
    for (const f of files) {
      try {
        const got = await storage.get(f.key);
        log(`  ✓ ${f.key}  ${got.contentType}  ${(got.buffer.length / 1024).toFixed(1)} KB`);
      } catch (e) {
        warn(`  ✗ ${f.key}  ${e.message}`);
      }
    }

    log('\n✓ 迁移完成。');
    log('  下一步：把 .env 的 STORAGE_DRIVER 改为 r2，然后 docker compose up -d 启动服务。');
    log('  注意：应用启动后会重新读取 db.json，届时改写才会生效；在此之前请勿提前启动旧容器。');
  })();
}

main().catch((e) => {
  console.error('迁移失败:', e);
  process.exit(1);
});
