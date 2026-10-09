// store.mjs against a real Postgres. Skips unless TEST_DATABASE_URL names a throwaway database (CI runs one; locally, for example
// `docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test postgres:17-alpine` and postgres://postgres:test@127.0.0.1:55432/postgres).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bytes } from "./rows.mjs";
import { prepare, reads, writes } from "./store.mjs";

const url = process.env.TEST_DATABASE_URL;
const b = (byte, n = 32) => bytes(`0x${byte.repeat(n)}`), h = (byte, n = 32) => `0x${byte.repeat(n)}`;
const sender = b("44", 20), round = b("22");
const at = (block, log_index) => ({ block, log_index, tx: b(block.toString(16).padStart(2, "0").slice(-2)) });
const request = (id, block, log_index) => ({ request_id: b(id), sender, ...at(block, log_index) });
const range = {
  requests: [request("01", 10, 0), request("02", 12, 0), request("03", 12, 3)],
  completions: [{ request_id: b("01"), ...at(11, 1), status: 0, error_code: 0, error_message: "" }],
  receipts: [{ ...at(11, 2), request_id: b("01"), data: Buffer.from([2]) }, { ...at(11, 0), request_id: b("01"), data: Buffer.from([1]) }],
  records: [{ ...at(11, 3), request_id: b("01"), kind: "settle", round_id: round, data: Buffer.concat([round, Buffer.alloc(192)]) },
    { ...at(13, 0), request_id: b("03"), kind: "clock", round_id: null, data: Buffer.alloc(224, 1) }],
};

test("schema, compare-and-set writes, account pages, rewinds and prices on Postgres", { skip: !url && "TEST_DATABASE_URL is not set" }, async () => {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 2, onnotice: () => {} }), writer = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await sql`drop table if exists cursors, requests, completions, receipts, records, btc_minutes`;
    await prepare(writer, 9);
    await prepare(writer, 9); // idempotent
    const w = writes(writer), r = reads(sql), count = async () => Number((await sql`select (select count(*) from requests) + (select count(*) from receipts) + (select count(*) from records) as n`)[0].n);
    assert.deepEqual(await w.cursor("horizen"), { block: 9, hash: null, time: null, sig: null });

    await w.write("horizen", { block: 9 }, { block: 20, hash: h("aa"), time: 1_020 }, range);
    await assert.rejects(w.write("horizen", { block: 9 }, { block: 30, hash: h("bb"), time: 1_030 }, range), { lost: true }); // a second writer
    assert.equal(await count(), 7);
    assert.deepEqual(await w.cursor("horizen"), { block: 20, hash: h("aa"), time: 1_020, sig: null });

    const page = await r.account(h("44", 20), null, 2);
    assert.deepEqual(page.map((x) => [x.requestId, x.block, x.logIndex]), [[h("03"), 12, 3], [h("02"), 12, 0]]);
    const [first] = await r.account(h("44", 20), { block: 12, logIndex: 0 }, 2);
    assert.deepEqual(first, { requestId: h("01"), block: 10, logIndex: 0, txHash: h("0a"), ciphertexts: ["AQ==", "Ag=="], // in log order
      completed: { block: 11, txHash: h("0b"), status: 0, errorCode: 0, errorMessage: "" } });
    assert.deepEqual(await r.account(h("55", 20), null, 50), []);
    assert.deepEqual((await r.settles([h("22"), h("33")])).map((x) => [x.roundId, x.block, x.logIndex]), [[h("22"), 11, 3]]);
    assert.equal((await r.clock()).block, 13);
    assert.deepEqual(await r.head(), { block: 20, time: 1_020 });

    await w.rewind("horizen", { block: 20 }, { block: 11, hash: h("cc"), time: 1_011 }); // everything above block 11 goes
    assert.deepEqual((await sql`select block from requests union all select block from receipts union all select block from records order by 1`).map((x) => Number(x.block)), [10, 11, 11, 11]);
    await w.write("horizen", { block: 11 }, { block: 20, hash: h("aa"), time: 1_020 }, range); // the same rows again: nothing doubles
    assert.equal(await count(), 7);

    await w.prices({ sig: null }, { sig: "s1", time: 2_000 }, [{ minute: 1_920, price: "2", observed_at: 1_921, signature: "s1" }]);
    await w.prices({ sig: "s1" }, { sig: "s2", time: 2_001 }, [{ minute: 1_920, price: "1", observed_at: 1_920, signature: "s2" }, { minute: 1_980, price: "3", observed_at: 1_981, signature: "s2" }]);
    await w.prices({ sig: "s2" }, { sig: "s3", time: 2_002 }, [{ minute: 1_920, price: "9", observed_at: 1_925, signature: "s3" }]); // a later observation: kept out
    await assert.rejects(w.prices({ sig: "s1" }, { sig: "s4", time: 2_003 }, []), { lost: true });
    assert.deepEqual(await r.prices(1_900, 2_000), [{ minute: 1_920, price: "1" }, { minute: 1_980, price: "3" }]);
    assert.deepEqual([...await w.held(1_950)], [1_980]);
    assert.deepEqual(await w.cursor("solana"), { block: 0, hash: null, time: 2_002, sig: "s3" });
    const s = await r.status();
    assert.deepEqual([s.horizen, s.minute, s.dbBytes > 0], [{ block: 20, time: 1_020 }, 1_980, true]);
  } finally {
    await Promise.all([sql.end(), writer.end()]);
  }
});

// README "Switch-over to a new application": the reset exactly as written there.
const reset = readFileSync(new URL("./README.md", import.meta.url), "utf8").match(/```sql\n([\s\S]*?)```/)[1];

test("switch-over: a new application waits on the old one's rows; the README's reset keeps prices and the old rows, and only once the old writer is gone",
  { skip: !url && "TEST_DATABASE_URL is not set" }, async () => {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, { max: 2, onnotice: () => {} }), writer = postgres(url, { max: 1, onnotice: () => {} });
  const old = 7408397676477227659n;
  try {
    await sql`drop schema if exists app_7408397676477227659 cascade`;
    await sql`drop table if exists cursors, requests, completions, receipts, records, btc_minutes`;
    await prepare(writer, 9); // the old application, deployed at block 10
    const w = writes(writer);
    await w.write("horizen", { block: 9 }, { block: 20, hash: h("aa"), time: 1_020 }, range);
    await w.prices({ sig: null }, { sig: "s1", time: 2_000 }, [{ minute: 1_920, price: "2", observed_at: 1_921, signature: "s1" }]);
    assert.equal(await w.foreign(9), false, "its own rows");
    assert.equal(await w.foreign(12), true, "a new application deployed at block 13 finds the old one's requests at 10 and 12");
    assert.equal(await w.foreign(10), true);

    // The old writer still holds its lock: the reset refuses and changes nothing.
    await writer`select pg_advisory_lock(${old.toString()}::bigint)`;
    await assert.rejects(sql.unsafe(reset), /is still running/);
    assert.equal(Number((await sql`select count(*) as n from requests`)[0].n), 3);
    await writer`select pg_advisory_unlock(${old.toString()}::bigint)`;

    await sql.unsafe(reset);
    assert.deepEqual((await sql`select name, block, sig from cursors order by name`).map((r) => [r.name, Number(r.block), r.sig]), [["solana", 0, "s1"]]);
    assert.deepEqual((await sql`select minute, price from btc_minutes`).map((r) => [Number(r.minute), r.price]), [[1_920, "2"]]);
    assert.deepEqual(await Promise.all(["requests", "completions", "receipts", "records"].map(async (t) => Number((await sql`select count(*) as n from ${sql("app_7408397676477227659")}.${sql(t)}`)[0].n))), [3, 1, 2, 2]);
    assert.equal((await sql`select to_regclass('public.requests') as t`)[0].t, null);
    await assert.rejects(sql.unsafe(reset), /already exists/, "a second run changes nothing");

    await prepare(writer, 12); // the new application's indexer, on its next look
    assert.equal(await w.foreign(12), false);
    assert.deepEqual(await w.cursor("horizen"), { block: 12, hash: null, time: null, sig: null });
    assert.equal(Number((await sql`select count(*) as n from requests`)[0].n), 0);
    assert.deepEqual(await reads(sql).settles([h("22")]), []);
  } finally {
    await Promise.all([sql.end(), writer.end()]);
  }
});
