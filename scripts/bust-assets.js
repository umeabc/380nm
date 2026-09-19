'use strict';
const fs = require('fs');
const path = require('path');
const V = '6';
const dir = path.join(__dirname, '..', 'public');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html'));
let n = 0;
for (const f of files) {
  const p = path.join(dir, f);
  let s = fs.readFileSync(p, 'utf8');
  const before = s;
  s = s.replace(/href="\/css\/app\.css(?:\?v=[^"]*)?"/g, `href="/css/app.css?v=${V}"`);
  s = s.replace(/src="\/js\/([a-zA-Z0-9_/.-]+\.js)(?:\?v=[^"]*)?"/g, `src="/js/$1?v=${V}"`);
  if (s !== before) { fs.writeFileSync(p, s); n++; }
}
console.log('更新页面数:', n, '| 版本:', V);
