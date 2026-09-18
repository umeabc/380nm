class Scheduler {
  constructor({ store, storage, bili, config }) {
    this.store = store;
    this.storage = storage;
    this.bili = bili;
    this.cfg = config;
    this._timer = null;
    this._busy = false;
  }

  start() {
    this.recover().catch((e) => console.error('[scheduler] 恢复任务失败:', e));
    if (this._timer) return;
    this._timer = setInterval(() => {
      this.tick().catch((e) => console.error('[scheduler]', e));
    }, this.cfg.intervalMs);
    this.tick().catch((e) => console.error('[scheduler]', e));
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** 服务重启后，把卡在“发布中”的任务重新放回队列 */
  async recover() {
    const stuck = this.store.listJobs().filter((j) => j.status === 'publishing');
    for (const j of stuck) {
      await this.store.updateJob(j.id, {
        status: 'pending',
        scheduledAt: new Date().toISOString(),
        lastError: '服务重启，任务已自动重新排队'
      });
      await this.store.addLog('error', `任务 ${j.id} 因服务重启重新排队`, { jobId: j.id });
    }
    await this.store.addLog('info', '服务启动完成');
  }

  async tick() {
    if (this._busy) return;
    this._busy = true;
    try {
      const now = Date.now();
      const due = this.store
        .listJobs()
        .filter((j) => j.status === 'pending' && new Date(j.scheduledAt).getTime() <= now)
        .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt));
      for (const job of due) {
        await this.processJob(job.id);
      }
    } finally {
      this._busy = false;
    }
  }

  async processJob(jobId) {
    const job = this.store.getJob(jobId);
    if (!job || job.status !== 'pending') return;
    const account = this.store.getAccount(job.accountId);
    await this.store.updateJob(job.id, { status: 'publishing' });
    const tag = `[${job.id}] ${job.templateName} -> ${account ? account.uname || account.name : job.accountName || '未知账号'}`;
    try {
      if (!account) throw new Error('绑定的账号已不存在，请编辑任务重新选择账号');
      const pictures = [];
      for (const img of job.images || []) {
        const { buffer, contentType } = await this.storage.get(img.key);
        const up = await this.bili.uploadImage({
          sessdata: account.sessdata,
          csrf: account.bili_jct,
          buffer,
          filename: img.name || 'image.jpg',
          contentType
        });
        pictures.push(up);
      }
      const result = await this.bili.createDynamic({
        sessdata: account.sessdata,
        csrf: account.bili_jct,
        uid: account.uid,
        text: job.text,
        pictures,
        topic: job.topic || null,
        title: job.title || ''
      });
      await this.store.updateJob(job.id, {
        status: 'published',
        publishedAt: new Date().toISOString(),
        dynamicId: result.dynamicId,
        dynamicUrl: result.url,
        lastError: null
      });
      await this.store.addLog('success', `${tag} 发布成功 ${result.url}`,
        { jobId: job.id, userId: job.userId });
    } catch (e) {
      const attempts = (job.attempts || 0) + 1;
      const willRetry = attempts < this.cfg.maxAttempts;
      const patch = { attempts, lastError: e.message };
      if (willRetry) {
        patch.status = 'pending';
        patch.scheduledAt = new Date(Date.now() + this.cfg.retryDelayMs).toISOString();
      } else {
        patch.status = 'failed';
      }
      await this.store.updateJob(job.id, patch);
      await this.store.addLog(
        'error',
        `${tag} 第${attempts}次尝试失败: ${e.message}${willRetry ? '，将自动重试' : '，已达最大重试次数'}`,
        { jobId: job.id, userId: job.userId }
      );
    }
  }

  async publishNow(jobId) {
    const job = this.store.getJob(jobId);
    if (!job) throw new Error('任务不存在');
    if (job.status === 'publishing') throw new Error('任务正在发布中');
    if (job.status === 'published') throw new Error('任务已发布，无法重复发布');
    await this.store.updateJob(job.id, {
      status: 'pending',
      scheduledAt: new Date().toISOString(),
      lastError: null
    });
    this.tick().catch(() => {});
  }
}

module.exports = { Scheduler };
