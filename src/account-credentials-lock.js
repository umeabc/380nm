class AccountCredentialsLock {
  constructor() { this.tails = new Map(); }
  async tryExclusive(id, fn) {
    if (this.tails.has(id)) return { executed: false, skipped: true };
    return { executed: true, result: await this.runExclusive(id, fn) };
  }
  async runExclusive(id, fn) {
    const previous = this.tails.get(id) || Promise.resolve();
    let release; const gate = new Promise(resolve => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => gate); this.tails.set(id, tail);
    await previous.catch(() => {});
    try { return await fn(); }
    finally { release(); if (this.tails.get(id) === tail) this.tails.delete(id); }
  }
}
module.exports = { AccountCredentialsLock };
