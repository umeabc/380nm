'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
function list(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? list(file) : file.endsWith('.js') ? [file] : [];
  });
}
const files = [path.join(root, 'server.js'), ...['src', 'public/js', 'scripts'].flatMap(dir => list(path.join(root, dir)))];
for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
  if (check.status !== 0) { console.error(check.stderr); process.exit(1); }
}
console.log(`语法检查通过：${files.length} 个 JavaScript 文件`);
