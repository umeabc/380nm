const path = require('path');

/** 严格 0/1 开关：非法值直接启动失败，避免「以为开了其实没开」。 */
function flag01(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  if (v === '0') return false;
  if (v === '1') return true;
  throw new Error(`${name} 只接受 0 或 1，当前值：${String(v).slice(0, 20)}`);
}

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
  },
  // 账号 Cookie 巡检（账号管理页展示正常/异常）
  cookieMonitor: {
    intervalMs: Number(process.env.COOKIE_CHECK_INTERVAL || 30 * 60 * 1000),
    startupDelayMs: Number(process.env.COOKIE_CHECK_STARTUP_DELAY || 8000),
    gapMs: Number(process.env.COOKIE_CHECK_GAP || 1500)
  },
  // 有登录链的账号自动续期（扫码登录获得的 refresh_token 五步旋转）。
  // 设 0 只关闭 passport 自动检查/旋转/恢复，保留 30 分钟 nav 校验、扫码与提醒；恢复侧文件不删除。
  cookieAutoRefresh: flag01('COOKIE_AUTO_REFRESH', true)
};

module.exports = { config };
