import { constants } from 'node:fs';
import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { requireCondition } from './streams.mjs';

export const encodeJSON = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
export function validateJournal(data, identity) {
  const hash = v => typeof v === 'string' && /^0x[0-9a-f]{64}$/i.test(v) && !/^0x0{64}$/i.test(v);
  const address = v => typeof v === 'string' && /^0x[0-9a-f]{40}$/i.test(v) && !/^0x0{40}$/i.test(v);
  const unsigned = (v, max, positive = false) => /^(0|[1-9][0-9]*)$/.test(String(v)) && typeof v !== 'number'
    && String(v).length <= 78 && BigInt(v) <= max && (!positive || BigInt(v) > 0n);
  requireCondition(data.schemaVersion === 1 && data.identity === identity && Array.isArray(data.transactions)
    && data.activeRounds && typeof data.activeRounds === 'object' && !Array.isArray(data.activeRounds), 'KEEPER_JOURNAL_IDENTITY');
  const keys = new Set(), hashes = new Set(); let uncertain = false;
  for (const record of data.transactions) {
    const t = record?.transaction;
    requireCondition(record && typeof record.key === 'string' && /^[a-z0-9:]{1,200}$/.test(record.key) && !keys.has(record.key)
      && hash(record.hash) && !hashes.has(record.hash) && address(record.from) && ['base', 'horizen'].includes(record.chain)
      && ['signed', 'submitted', 'confirmed', 'reverted'].includes(record.status), 'KEEPER_JOURNAL_RECORD');
    requireCondition(!uncertain, 'KEEPER_JOURNAL_UNCERTAIN_PREFIX');
    keys.add(record.key); hashes.add(record.hash);
    requireCondition(t && t.type === 'eip1559' && t.chainId === (record.chain === 'base' ? 8453 : 26514) && address(t.to)
      && Number.isSafeInteger(t.nonce) && t.nonce >= 0 && unsigned(t.value, 0n)
      && typeof t.data === 'string' && /^0x(?:[0-9a-fA-F]{2}){4,20000}$/.test(t.data)
      && unsigned(t.gas, 2500000n, true) && unsigned(t.maxFeePerGas, 1000000000n, true)
      && unsigned(t.maxPriorityFeePerGas, BigInt(t.maxFeePerGas))
      && unsigned(record.maximumFeeWei, 250000000000000n, true)
      && BigInt(record.maximumFeeWei) >= BigInt(t.gas) * BigInt(t.maxFeePerGas), 'KEEPER_JOURNAL_FEE_OR_INTENT');
    if (['confirmed', 'reverted'].includes(record.status)) {
      requireCondition(record.receipt && record.receipt.status === (record.status === 'confirmed' ? 'success' : 'reverted')
        && hash(record.receipt.blockHash) && unsigned(record.receipt.blockNumber, 2n ** 64n - 1n)
        && unsigned(record.receipt.timestamp, 0xffffffffn, true), 'KEEPER_JOURNAL_RECEIPT');
    } else uncertain = true;
  }
  return data;
}
export async function privateFile(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const s = await handle.stat(); requireCondition(s.isFile() && (s.mode & 0o777) === 0o600 && s.size <= 16384, 'KEEPER_SECRET_PERMISSIONS'); return await handle.readFile(); }
  finally { await handle.close(); }
}

export class Journal {
  #path; #lock; #handle; data;
  static async acquire(directory, identity) {
    const journal = new Journal(); const folder = resolve(directory);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    journal.#path = resolve(folder, 'state.json'); journal.#lock = resolve(folder, 'keeper.lock');
    // No automatic stale-lock deletion: an operator must establish that the old writer has stopped.
    journal.#handle = await open(journal.#lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await journal.#handle.writeFile(encodeJSON({ pid: process.pid, identity })); await journal.#handle.sync();
    try {
      let handle;
      try { handle = await open(journal.#path, constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (handle) {
        try { const stat = await handle.stat(); requireCondition(stat.isFile() && stat.size <= 32 * 1024 * 1024 && (stat.mode & 0o777) === 0o600, 'KEEPER_JOURNAL_FILE'); journal.data = JSON.parse(await handle.readFile('utf8')); }
        finally { await handle.close(); }
        validateJournal(journal.data, identity);
      } else journal.data = { schemaVersion: 1, identity, transactions: [], activeRounds: {} };
      await journal.save(); return journal;
    } catch (e) { await journal.close(); throw e; }
  }
  async save() {
    const temporary = `${this.#path}.${process.pid}.next`;
    const value = encodeJSON(this.data);
    requireCondition(Buffer.byteLength(value) <= 32 * 1024 * 1024, 'KEEPER_JOURNAL_CAPACITY');
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.#path);
    const directory = await open(dirname(this.#path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  }
  async close() { if (this.#handle) { await this.#handle.close(); this.#handle = null; await unlink(this.#lock); } }
}
