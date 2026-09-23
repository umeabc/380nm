const path = require('path');

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 8787),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    localDir: process.env.UPLOAD_DIR || path.join(__dirname, '..', 'data', 'uploads'),
    r2: {
      accountId: process.env.R2_ACCOUNT_ID || '',
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      bucket: process.env.R2_BUCKET || '',
      publicBase: process.env.R2_PUBLIC_BASE || '',
      // R2 配额（免费额度 10GB），用于图库页展示「存储剩余」；按需用 R2_QUOTA_GB 覆盖
      quotaGb: Number(process.env.R2_QUOTA_GB || 10)
    }
  },
  scheduler: {
    intervalMs: Number(process.env.SCHEDULER_INTERVAL || 20000),
    maxAttempts: Number(process.env.MAX_ATTEMPTS || 3),
    retryDelayMs: Number(process.env.RETRY_DELAY_MS || 60000)
  }
};

module.exports = { config };
