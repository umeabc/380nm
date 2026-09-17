const fsp = require('fs/promises');
const path = require('path');

async function reset() {
  const dataDir = path.join(__dirname, '..', 'data');
  try {
    await fsp.rm(dataDir, { recursive: true, force: true });
  } catch (e) {
    console.error(e);
  }
  console.log('已清空 data 目录（db.json 与上传图片）。下次启动时将重新生成默认模板。');
}

reset();
