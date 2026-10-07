// The database (schema.sql). Writes go only through `writer`, the one connection that holds the indexer's advisory lock, each in
// one transaction that first moves its cursor compare-and-set: a second writer (a lock lost with its connection, a deploy
// overlap) finds the cursor moved and rolls back, so a range is never written twice over or past a rewind. Reads use the API's pool.
import { readFile } from "node:fs/promises";
import { bytes, hex } from "./rows.mjs";

const TABLES = {
  requests: ["request_id", "sender", "block", "log_index", "tx"],
  completions: ["request_id", "block", "log_index", "tx", "status", "error_code", "error_message"],
  receipts: ["block", "log_index", "request_id", "tx", "data"],
  records: ["block", "log_index", "tx", "request_id", "kind", "round_id", "data"],
};
const CHUNK = 1_000; // rows per insert (a statement takes at most 65,535 parameters)
const moved = () => Object.assign(new Error("INDEXER_CURSOR_MOVED"), { code: "INDEXER_CURSOR_MOVED", lost: true });
const n = (v) => v === null ? null : Number(v);

/** The schema and both cursors (Horizen from `start`, the block before the application's deployment). Writer only. */
export async function prepare(writer, start) {
  await writer.unsafe(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
  await writer`insert into cursors (name, block) values ('horizen', ${start}), ('solana', 0) on conflict do nothing`;
}

export const writes = (writer) => ({
  async cursor(name) {
    const [r] = await writer`select block, hash, time, sig from cursors where name = ${name}`;
    return { block: Number(r.block), hash: r.hash && hex(r.hash), time: n(r.time), sig: r.sig };
  },
  write: (name, expect, next, rows) => writer.begin(async (sql) => {
    if ((await sql`update cursors set block = ${next.block}, hash = ${bytes(next.hash)}, time = ${next.time} where name = ${name} and block = ${expect.block}`).count !== 1) throw moved();
    for (const [table, columns] of Object.entries(TABLES)) for (let i = 0; i < rows[table].length; i += CHUNK) {
      await sql`insert into ${sql(table)} ${sql(rows[table].slice(i, i + CHUNK), columns)} on conflict do nothing`;
    }
  }),
  rewind: (name, expect, fork) => writer.begin(async (sql) => {
    if ((await sql`update cursors set block = ${fork.block}, hash = ${bytes(fork.hash)}, time = ${fork.time} where name = ${name} and block = ${expect.block}`).count !== 1) throw moved();
    for (const table of Object.keys(TABLES)) await sql`delete from ${sql(table)} where block > ${fork.block}`;
  }),
  async held(from) {
    return new Set((await writer`select minute from btc_minutes where minute >= ${from}`).map((r) => Number(r.minute)));
  },
  // The earliest observation of each minute stays, whatever order transactions are read in.
  prices: (expect, next, minutes) => writer.begin(async (sql) => {
    if ((await sql`update cursors set sig = ${next.sig}, time = ${next.time} where name = 'solana' and sig is not distinct from ${expect.sig}::text`).count !== 1) throw moved();
    if (minutes.length) await sql`insert into btc_minutes ${sql(minutes, ["minute", "price", "observed_at", "signature"])} on conflict (minute)
      do update set price = excluded.price, observed_at = excluded.observed_at, signature = excluded.signature where excluded.observed_at < btc_minutes.observed_at`;
  }),
});

const record = (r) => ({ block: Number(r.block), logIndex: r.log_index, txHash: hex(r.tx), data: hex(r.data) });

export const reads = (sql) => ({
  async head() {
    const [r] = await sql`select block, time from cursors where name = 'horizen'`;
    return r ? { block: Number(r.block), time: n(r.time) } : null;
  },
  async clock() {
    const [r] = await sql`select block, log_index, tx, data from records where kind = 'clock' order by block desc, log_index desc limit 1`;
    return r ? record(r) : null;
  },
  /** Settle records of these registry round ids (0x hex), in chain order. */
  async settles(ids) {
    if (!ids.length) return [];
    return (await sql`select block, log_index, tx, round_id, data from records where kind = 'settle' and round_id in ${sql(ids.map(bytes))} order by block, log_index`)
      .map((r) => ({ ...record(r), roundId: hex(r.round_id) }));
  },
  async prices(from, to) {
    return (await sql`select minute, price from btc_minutes where minute between ${from} and ${to} order by minute`).map((r) => ({ minute: Number(r.minute), price: r.price }));
  },
  async latestPrice() {
    const [r] = await sql`select minute, price from btc_minutes order by minute desc limit 1`;
    return r ? { minute: Number(r.minute), price: r.price } : null;
  },
  /** An account's requests, newest first, before (block, logIndex) when given, each with its encrypted receipts in chain order. */
  async account(address, before, limit) {
    const rows = await sql`
      select r.request_id, r.block, r.log_index, r.tx, c.block as done_block, c.tx as done_tx, c.status, c.error_code, c.error_message,
        array(select u.data from receipts u where u.request_id = r.request_id order by u.block, u.log_index) as ciphertexts
      from requests r left join completions c on c.request_id = r.request_id
      where r.sender = ${bytes(address)} ${before ? sql`and (r.block, r.log_index) < (${before.block}, ${before.logIndex})` : sql``}
      order by r.block desc, r.log_index desc limit ${limit}`;
    return rows.map((r) => ({ requestId: hex(r.request_id), block: Number(r.block), logIndex: r.log_index, txHash: hex(r.tx),
      completed: r.done_block === null ? null : { block: Number(r.done_block), txHash: hex(r.done_tx), status: r.status, errorCode: r.error_code, errorMessage: r.error_message },
      ciphertexts: r.ciphertexts.map((c) => c.toString("base64")) }));
  },
  async status() {
    const [cursors, [size], [latest]] = await Promise.all([sql`select name, block, time from cursors`, sql`select pg_database_size(current_database()) as bytes`,
      sql`select max(minute) as minute from btc_minutes`]);
    const h = cursors.find((c) => c.name === "horizen");
    return { horizen: h ? { block: Number(h.block), time: n(h.time) } : null, minute: n(latest.minute), dbBytes: Number(size.bytes) };
  },
});
