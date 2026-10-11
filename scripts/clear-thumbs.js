'use strict';
const fs = require('fs/promises');
const path = require('path');
const { thumbnailConfig } = require('../src/thumb-config');

// 默认只打印计划，执行必须显式重复核实绝对派生根；拒绝跟随链接。
async function main() {
  const args = process.argv.slice(2);
  const cfg = thumbnailConfig();
  const root = path.resolve(cfg.root);
  if (path.basename(root) !== 'thumbs' || path.dirname(root) === root || root === path.parse(root).root) throw new Error('危险清理根');
  console.log('核实派生根:', root);
  const execute = args.includes('--execute');
  if (execute && !args.includes('--confirm=' + root)) throw new Error('执行需要 --confirm=<上述绝对根>，请先停服务');
  const mode = args.includes('--all') ? 'all' : args.includes('--old') ? 'old' : args.includes('--orphans') ? 'orphans' : 'old';
  const files = [];
  async function walk(dir) {
    const stat = await fs.lstat(dir).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error('拒绝符号链接: ' + dir);
    if (!stat.isDirectory()) throw new Error('派生根非目录');
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) throw new Error('拒绝符号链接: ' + p);
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile()) files.push(p);
    }
  }
  await walk(root);
  let bytes = 0, count = 0;
  for (const file of files) {
    const orphan = file.endsWith('.tmp') || (file.endsWith('.json') && !files.includes(file.replace(/\.json$/, '.webp'))) || (file.endsWith('.webp') && !files.includes(file.replace(/\.webp$/, '.json')));
    if (mode === 'all' || (mode === 'old' && !file.startsWith(path.join(root, cfg.algorithm) + path.sep)) || (mode === 'orphans' && orphan)) {
      bytes += (await fs.stat(file)).size; count++; console.log(execute ? '删除' : 'dry-run', file);
      if (execute) await fs.unlink(file);
    }
  }
  console.log(JSON.stringify({ mode, execute, files: count, bytes }));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
