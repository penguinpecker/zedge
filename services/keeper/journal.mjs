import { constants } from 'node:fs';
import { open, mkdir, rename, unlink, readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { requireCondition } from './streams.mjs';

export const encodeJSON = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
// signed -> submitted -> mined (seen in a block) are open. A record ends as confirmed or reverted (canonical
// receipt), or dropped (another hash signed for the same nonce was mined instead).
export const FINAL = ['confirmed', 'reverted', 'dropped'];
export const STATUSES = ['signed', 'submitted', 'mined', ...FINAL];
export const TX_GAS_CAP = 2n ** 24n; // EIP-7825 per-transaction gas limit
export const TX_SHARE = 20n; // one transaction may reserve at most 1/20 of a chain's rolling budget
export const DAILY_MAXIMUM = { base: 250000000000000000n, horizen: 50000000000000000n }; // upper bound an operator may set
const WINDOW_HOURS = 24;

// Wei charged to a chain's budget in the rolling window: what settled transactions cost, plus the reservation of
// every nonce still open. Hashes signed for one nonce exclude each other, so a nonce reserves only its largest.
export function spent(data, chain, now = Date.now()) {
  const hour = Math.floor(now / 3600000), reserved = new Map(); let total = 0n;
  for (const [key, wei] of Object.entries(data.spent[chain] ?? {})) if (Number(key) >= hour - WINDOW_HOURS) total += BigInt(wei);
  for (const t of data.transactions) {
    if (t.chain !== chain || FINAL.includes(t.status)) continue;
    const wei = BigInt(t.maximumFeeWei); if (wei > (reserved.get(t.transaction.nonce) ?? 0n)) reserved.set(t.transaction.nonce, wei);
  }
  for (const wei of reserved.values()) total += wei;
  return total;
}

export function validateJournal(data, identity) {
  const hash = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v);
  const address = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
  const unsigned = (v, max, positive = false) => /^(0|[1-9][0-9]*)$/.test(String(v)) && typeof v !== 'number'
    && String(v).length <= 78 && BigInt(v) <= max && (!positive || BigInt(v) > 0n);
  const plain = v => v && typeof v === 'object' && !Array.isArray(v);
  requireCondition(data.schemaVersion === 2 && data.identity === identity && Array.isArray(data.transactions)
    && [data.activeRounds, data.nonces, data.spent, data.attempts, data.settled ?? {}].every(plain)
    && (data.catchUp === undefined || Number.isSafeInteger(data.catchUp) && data.catchUp >= 0)
    && (data.catchUpEnd === undefined || Number.isSafeInteger(data.catchUpEnd)), 'KEEPER_JOURNAL_IDENTITY');
  const keys = new Set(), hashes = new Set();
  // `settled` keeps each chain's last settled record (chain.mjs, rewind). It passes the same checks, except that its
  // key and hash need not be unique: the intent it closed may be open again under the same attempt number.
  for (const [record, last] of [...data.transactions.map(record => [record]), ...Object.entries(data.settled ?? {}).map(([chain, record]) => [record, chain])]) {
    const t = record?.transaction;
    requireCondition(record && typeof record.key === 'string' && /^[a-z0-9:]{1,200}$/.test(record.key) && (last || !keys.has(record.key))
      && hash(record.hash) && (last || !hashes.has(record.hash)) && address(record.from) && ['base', 'horizen'].includes(record.chain)
      && (last ? record.chain === last && ['confirmed', 'reverted'].includes(record.status) : STATUSES.includes(record.status)), 'KEEPER_JOURNAL_RECORD');
    if (!last) { keys.add(record.key); hashes.add(record.hash); }
    // Caps are wei. The only gas bound is the chain's own per-transaction limit; the wei bound is the largest
    // share of the largest budget an operator may configure.
    const cap = DAILY_MAXIMUM[record.chain] / TX_SHARE;
    requireCondition(t && t.type === 'eip1559' && t.chainId === (record.chain === 'base' ? 8453 : 26514) && address(t.to)
      && Number.isSafeInteger(t.nonce) && t.nonce >= 0 && unsigned(t.value, 0n)
      && typeof t.data === 'string' && /^0x(?:[0-9a-fA-F]{2}){4,20000}$/.test(t.data)
      && unsigned(t.gas, TX_GAS_CAP, true) && unsigned(t.maxFeePerGas, cap, true)
      && unsigned(t.maxPriorityFeePerGas, BigInt(t.maxFeePerGas))
      && unsigned(record.maximumFeeWei, cap, true)
      && BigInt(record.maximumFeeWei) >= BigInt(t.gas) * BigInt(t.maxFeePerGas), 'KEEPER_JOURNAL_FEE_OR_INTENT');
    if (['confirmed', 'reverted'].includes(record.status)) {
      requireCondition(record.receipt && record.receipt.status === (record.status === 'confirmed' ? 'success' : 'reverted')
        && hash(record.receipt.blockHash) && unsigned(record.receipt.blockNumber, 2n ** 64n - 1n)
        && unsigned(record.receipt.timestamp, 0xffffffffn, true) && unsigned(record.receipt.feeWei, cap), 'KEEPER_JOURNAL_RECEIPT');
    }
  }
  for (const chain of Object.keys({ ...data.nonces, ...data.spent })) {
    requireCondition(['base', 'horizen'].includes(chain) && (data.nonces[chain] === undefined || Number.isSafeInteger(data.nonces[chain]) && data.nonces[chain] >= 0)
      && (data.spent[chain] === undefined || plain(data.spent[chain]) && Object.entries(data.spent[chain]).every(([hour, wei]) =>
        /^[1-9][0-9]{0,6}$/.test(hour) && typeof wei === 'string' && unsigned(wei, DAILY_MAXIMUM[chain] * 2n))), 'KEEPER_JOURNAL_ACCOUNTING');
  }
  requireCondition(Object.entries(data.attempts).every(([intent, a]) => /^[a-z0-9:]{1,190}$/.test(intent) && plain(a)
    && [a.count, a.reverts, a.last].every(n => Number.isSafeInteger(n) && n >= 0)), 'KEEPER_JOURNAL_ATTEMPTS');
  return data;
}
// A failure of the state directory itself (permissions, a full or failing disk, no FIFO support, unparseable state)
// is reported by one fixed code, never by the system's own text.
const STORAGE = error => /^KEEPER_[A-Z_]+$/.test(error?.message) ? error : new Error('KEEPER_JOURNAL_STORAGE');
export async function privateFile(path) {
  // Missing, unreadable by this user or a symbolic link: the same answer as a wrong mode, and never the system's text.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new Error('KEEPER_SECRET_PERMISSIONS'); });
  try { const s = await handle.stat(); requireCondition(s.isFile() && (s.mode & 0o777) === 0o600 && s.size <= 16384, 'KEEPER_SECRET_PERMISSIONS'); return await handle.readFile(); }
  finally { await handle.close(); }
}

// One writer per state directory. A writer publishes keeper.<random>.lock (who it is: pid, host, boot id) beside
// keeper.<random>.live, a FIFO it holds open for reading until it ends. The kernel closes that descriptor when the
// process ends, however it ends, and opening a FIFO for writing without blocking fails with ENXIO exactly when no
// process has it open for reading. A takeover rests on that answer alone. The recorded pid is for the operator: it
// proves nothing, because every container's keeper is pid 1, pids are recycled, and one container cannot see
// another's processes. A kernel answers only for its own processes, so the record must also have been written
// under this kernel (same boot id) or, after a reboot or where there is no boot id, under this host name.
const WITNESS = constants.O_NONBLOCK | constants.O_NOFOLLOW;
async function ended(stem, here) {
  let owner;
  try { owner = JSON.parse(await readFile(`${stem}.lock`, 'utf8')); } catch (error) { return error.code === 'ENOENT'; } // withdrawn meanwhile; unreadable is not proof
  if (!(owner?.boot && owner.boot === here.boot) && owner?.host !== here.host) return false;
  try { await (await open(`${stem}.live`, constants.O_WRONLY | WITNESS)).close(); return false; } catch (error) { return error.code === 'ENXIO'; }
}

export class Journal {
  #path; #stem; #witness; #queue = Promise.resolve(); data;
  static async acquire(directory, identity) {
    const journal = new Journal(); const folder = resolve(directory);
    try {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      journal.#path = resolve(folder, 'state.json');
      const here = { host: hostname(), boot: await readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(text => text.trim(), () => '') };
      const stem = journal.#stem = resolve(folder, `keeper.${randomBytes(8).toString('hex')}`);
      // The witness is up before the record becomes visible, and comes down only after it is withdrawn (close).
      execFileSync('mkfifo', ['-m', '600', `${stem}.live`], { stdio: 'ignore' });
      journal.#witness = await open(`${stem}.live`, constants.O_RDONLY | WITNESS);
      const record = await open(`${stem}.tmp`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await record.writeFile(encodeJSON({ pid: process.pid, ...here, since: new Date(Date.now()).toISOString(), identity })); await record.sync(); } finally { await record.close(); }
      await rename(`${stem}.tmp`, `${stem}.lock`);
      // Publish, then look: of writers starting together at least one sees the other and withdraws, so two never
      // hold. A record whose writer has provably ended is removed; it is named after that writer alone, so removing
      // it can never remove a live writer's record.
      for (const name of await readdir(folder)) {
        const other = /^keeper\.[0-9a-f]{16}\.lock$/.test(name) ? resolve(folder, name.slice(0, -5)) : stem;
        if (other === stem) continue;
        requireCondition(await ended(other, here), 'KEEPER_LOCKED');
        for (const suffix of ['lock', 'live']) await unlink(`${other}.${suffix}`).catch(() => {});
      }
      let handle;
      try { handle = await open(journal.#path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (handle) {
        try { const stat = await handle.stat(); requireCondition(stat.isFile() && stat.size <= 32 * 1024 * 1024 && (stat.mode & 0o777) === 0o600, 'KEEPER_JOURNAL_FILE'); journal.data = JSON.parse(await handle.readFile('utf8')); }
        finally { await handle.close(); }
        validateJournal(journal.data, identity);
      // catchUp: a new directory has yet to look for older opened rounds, from this start time downwards (main.mjs, lookBack).
      // catchUpEnd, set by its first look: where that walk ends.
      } else journal.data = { schemaVersion: 2, identity, transactions: [], activeRounds: {}, nonces: {}, spent: {}, attempts: {}, catchUp: 0xffffffff };
      await journal.save(); return journal;
    } catch (e) { await journal.close(); throw STORAGE(e); }
  }
  // Both chains' lanes save; writes are strictly one after another. Any storage failure is must-stop: without a
  // durable record nothing may be signed.
  save() {
    const write = this.#queue.then(() => this.#write()).catch(error => { throw STORAGE(error); });
    this.#queue = write.catch(() => {}); return write;
  }
  async #write() {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW;
    // Settled records leave the state file for an append-only history, so the state that is rewritten and fsynced
    // before every send stays a few kilobytes however long the keeper runs. Their cost stays in `spent`.
    const settled = this.data.transactions.filter(t => FINAL.includes(t.status));
    if (settled.length) {
      const history = await open(resolve(dirname(this.#path), 'history.jsonl'), flags | constants.O_APPEND, 0o600);
      try { await history.writeFile(settled.map(t => JSON.stringify(t, (_, v) => typeof v === 'bigint' ? v.toString() : v) + '\n').join('')); await history.sync(); } finally { await history.close(); }
      this.data.transactions = this.data.transactions.filter(t => !settled.includes(t)); // only what was just appended
    }
    // Old hours leave a book relative to its own newest hour, never to the host clock: a start (which saves) under a
    // clock that is a day fast must not erase what the last day cost. spent() counts by the clock at send time, which
    // the run loop has by then checked against the chain.
    for (const book of Object.values(this.data.spent)) { const newest = Math.max(...Object.keys(book).map(Number)); for (const key of Object.keys(book)) if (Number(key) < newest - WINDOW_HOURS) delete book[key]; }
    const second = Math.floor(Date.now() / 1000);
    // An attempt counter outlives its day while a hash it numbered is still open: the next attempt must not reuse that number.
    for (const [intent, a] of Object.entries(this.data.attempts)) if (a.last < second - WINDOW_HOURS * 3600 && !this.data.transactions.some(t => t.key.startsWith(`${intent}:`))) delete this.data.attempts[intent];
    const temporary = `${this.#path}.${process.pid}.next`;
    const value = encodeJSON(this.data);
    requireCondition(Buffer.byteLength(value) <= 32 * 1024 * 1024, 'KEEPER_JOURNAL_CAPACITY');
    const handle = await open(temporary, flags | constants.O_TRUNC, 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.#path);
    const directory = await open(dirname(this.#path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  }
  async close() {
    const stem = this.#stem; if (!stem) return; this.#stem = null;
    await this.#queue;
    for (const suffix of ['tmp', 'lock']) await unlink(`${stem}.${suffix}`).catch(() => {}); // the record goes first
    await this.#witness?.close(); await unlink(`${stem}.live`).catch(() => {});
  }
}
