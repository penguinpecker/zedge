// The Horizen follower (README.md): one log range per step, behind a confirmation depth, with a reorg rewind. All chain and
// database access is in `deps`; the database write is one transaction that also moves the cursor (store.mjs).
export const RANGE = 1_000; // blocks per eth_getLogs at most (thirdweb's cap, and the site proxy's)
const BATCH = 50; // headers per JSON-RPC batch
const q = (n) => `0x${n.toString(16)}`;
const header = (n) => ({ method: "eth_getBlockByNumber", params: [q(n), false] });
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const fail = (code) => Object.assign(new Error(code), { code });
/** A provider's refusal of a log read that is too large (a block-range or result cap). */
export const tooLarge = (e) => e?.rpcCode === -32005 || /range|results|too (many|large)|limit|exceed|size/i.test(e?.rpcMessage ?? "");

/** One step. `c`: { name, start, depth, rewind, filter, span }; span is the blocks per read, halved on a size refusal and grown back.
 * `deps`: { rpc(calls) → results (one JSON-RPC batch), cursor(name) → { block, hash }, rows(logs), write(name, expect, next, rows),
 * rewind(name, expect, fork) }. */
export async function step(deps, c) {
  const cur = await deps.cursor(c.name);
  const [head] = await deps.rpc([{ method: "eth_blockNumber", params: [] }]);
  const safe = Number(head) - c.depth;
  if (!(safe > cur.block)) return { idle: true };
  const from = cur.block + 1, to = Math.min(safe, cur.block + c.span);
  // The cursor's header, the range's last header and its logs in one batch: one backend, one view of the chain. The cursor's
  // header is read here and not before, so a reorg below the cursor can never join the new fork's range to the old rows.
  let at, top, logs;
  try { [at, top, logs] = await deps.rpc([header(cur.block), header(to), { method: "eth_getLogs", params: [{ ...c.filter, fromBlock: q(from), toBlock: q(to) }] }]); }
  catch (e) { if (!tooLarge(e) || c.span === 1) throw e; c.span = Math.ceil(c.span / 2); return { span: c.span }; }
  if (!at || !top) throw fail("INDEXER_NODE_BEHIND"); // a backend that does not have these blocks yet
  if (cur.hash && !same(at.hash, cur.hash)) {
    // The block we stopped at is no longer canonical: read the last `rewind` blocks again.
    const fork = Math.max(c.start, cur.block - c.rewind), [b] = await deps.rpc([header(fork)]);
    if (!b) throw fail("INDEXER_NODE_BEHIND");
    await deps.rewind(c.name, cur, { block: fork, hash: b.hash, time: Number(b.timestamp) });
    return { reorg: true, from: cur.block, to: fork };
  }
  if (!Array.isArray(logs)) throw fail("INDEXER_RPC_SHAPE");
  const kept = logs.filter((l) => !l.removed);
  // Every log must sit on the chain whose header is stored: block `to` by the header read with the logs, any other block still
  // inside the rewind window by its own header. Older blocks are past the reorg ceiling, as the rewind window itself is.
  const hashes = new Map([[to, top.hash]]);
  const check = [...new Set(kept.map((l) => Number(l.blockNumber)).filter((n) => n !== to && n > Number(head) - c.rewind))];
  for (let i = 0; i < check.length; i += BATCH) {
    const part = check.slice(i, i + BATCH);
    (await deps.rpc(part.map(header))).forEach((b, k) => hashes.set(part[k], b?.hash));
  }
  for (const l of kept) {
    const n = Number(l.blockNumber);
    if (!(n >= from && n <= to)) throw fail("INDEXER_LOG_RANGE");
    if (hashes.has(n) && !same(l.blockHash, hashes.get(n))) throw fail("INDEXER_LOG_HASH");
  }
  await deps.write(c.name, cur, { block: to, hash: top.hash, time: Number(top.timestamp) }, deps.rows(kept));
  c.span = Math.min(RANGE, c.span * 2);
  return { from, to, logs: kept.length, behind: safe - to };
}
