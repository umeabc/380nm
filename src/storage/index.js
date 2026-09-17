async function createStorage(config) {
  if (config.storage.driver === 'r2') {
    const { R2Storage } = require('./r2');
    return R2Storage.create(config.storage.r2);
  }
  const { LocalStorage } = require('./local');
  const s = new LocalStorage(config.storage.localDir);
  await s.init();
  return s;
}

module.exports = { createStorage };
