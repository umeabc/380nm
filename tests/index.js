'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Support `node --test tests/` on Node versions that resolve a directory to index.js.
// Keep this entry point outside *.test.js so `npm test` still runs each file once.
for (const file of fs.readdirSync(__dirname).filter(name => name.endsWith('.test.js')).sort()) {
  require(path.join(__dirname, file));
}
