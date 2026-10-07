import { boundedJSON, covers, decodeReport, requireCondition } from './streams.mjs';
import { retryAfter } from './errors.mjs';

// The free report source (KEEPER_REPORT_SOURCE=solana). Programs on Solana post Chainlink Data Streams reports, whole
// and signed, in the data of their public transactions and verify them there. For a boundary this returns the first
// such copy whose signed window covers it, in the shape StreamsClient.report returns ({ payload, observation }).
// A copy is untrusted input like any other: main.mjs checks it as it checks the API's reports, and nothing is signed
// unless the Base adapter verifies it in simulation. Read on 2026-10-06, both sources carried the BTC/USD report of
// every 15-minute boundary of the previous 24 hours, the primary a median 4 s after it and the backup 1 s.
const SOURCES = {
  primary: '2SoQchZSfocDAagJDCpfzP3cYyrV6MzAUuAMH1vsmyt1', // Jupiter Forecast's keeper (ResolveMarketWithChainlink, UpdateMarketWithChainlink)
  backup: '2DeGBCAiEJd1MgMuPGDKh7svBikZa9izbnTn5p7ESzPt', // a round program (RecordOpen, ResolveRound; also SOL/USD, every minute)
};
// The only instructions a report is taken from, as "<program> <method discriminator>": the four methods that pass it
// to Chainlink's verifier on Solana (Gt9S41PtjR58CbG9JhJ3J6vxesqrNAswbWYbLNTMZA3c), so in a transaction that succeeded
// it was verified. A source's listing also holds anybody's transactions that merely name it, and an instruction of any
// other program or method can carry any data in a transaction that succeeds, for one signature fee.
const VERIFYING = new Set([
  '2sVcg2dBSUzXkmdZ8M5cp1LbnzDrWJmr6hktkHwB8nY3 2b1e2f2f66a03c59', // the primary's issuer program: UpdateMarketWithChainlink
  '2sVcg2dBSUzXkmdZ8M5cp1LbnzDrWJmr6hktkHwB8nY3 17ac99beddcf3a9c', // ResolveMarketWithChainlink
  '2DeGBCAiEJd1MgMuPGDKh7svBikZa9izbnTn5p7ESzPt a572ed9e012446fe', // the backup: ResolveRound
  '2DeGBCAiEJd1MgMuPGDKh7svBikZa9izbnTn5p7ESzPt 629c5b230fd5d8fc', // RecordOpen
]);
export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const EARLY = 5; // seconds a block's time may run ahead of the report in it
const LATE = 600; // seconds after a boundary a copy of its report is still looked for (the latest seen: 101 s)
const PAGES = 4; // signature pages per source and call: 25, then 1,000 each (about two days of the primary, four hours of the backup)
const TRANSACTIONS = 4; // transactions not read before, per source and call; the next call goes on from there
const FALLBACK = 60; // seconds after a boundary from which the paid client, when configured, is asked first (withFallback)
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(text) {
  requireCondition(typeof text === 'string' && text.length <= 2048, 'STREAMS_SOLANA_INSTRUCTION'); // a Solana transaction is at most 1,232 bytes
  let n = 0n;
  for (const c of text) { const digit = ALPHABET.indexOf(c); requireCondition(digit >= 0, 'STREAMS_SOLANA_INSTRUCTION'); n = n * 58n + BigInt(digit); }
  const hex = n ? n.toString(16) : '';
  return Buffer.concat([Buffer.alloc(text.length - text.replace(/^1+/, '').length), Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex')]);
}

// The raw Snappy block format (google/snappy, format_description.txt): a varint length, then literals and copies.
function unsnappy(input) {
  let i = 0, length = 0;
  for (let shift = 0; ; shift += 7) {
    requireCondition(i < input.length && shift < 35, 'STREAMS_SOLANA_INSTRUCTION');
    const byte = input[i++]; length += (byte & 0x7f) * 2 ** shift; if (byte < 0x80) break;
  }
  requireCondition(length <= 16384, 'STREAMS_SOLANA_INSTRUCTION'); // decodeReport's own bound
  const out = Buffer.alloc(length); let o = 0;
  while (i < input.length) {
    const tag = input[i++], type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) { requireCondition(i + n - 59 <= input.length, 'STREAMS_SOLANA_INSTRUCTION'); const k = n - 59; n = input.readUIntLE(i, k); i += k; }
      requireCondition(i + n + 1 <= input.length && o + n + 1 <= length, 'STREAMS_SOLANA_INSTRUCTION');
      input.copy(out, o, i, i + n + 1); i += n + 1; o += n + 1;
      continue;
    }
    const size = type === 1 ? 1 : type === 2 ? 2 : 4;
    requireCondition(i + size <= input.length, 'STREAMS_SOLANA_INSTRUCTION');
    const n = type === 1 ? ((tag >> 2) & 7) + 4 : (tag >> 2) + 1, offset = type === 1 ? ((tag >> 5) << 8) | input[i] : input.readUIntLE(i, size);
    i += size;
    requireCondition(offset > 0 && offset <= o && o + n <= length, 'STREAMS_SOLANA_INSTRUCTION');
    for (let k = 0; k < n; k++, o++) out[o] = out[o - offset];
  }
  requireCondition(o === length, 'STREAMS_SOLANA_INSTRUCTION');
  return out;
}

// One instruction's data (base58): an 8-byte method discriminator, then the report as a byte vector (u32 length,
// little-endian) holding a Snappy-compressed full report. Throws for anything else.
const payloadOf = raw => {
  const length = raw.readUInt32LE(8);
  requireCondition(12 + length <= raw.length, 'STREAMS_SOLANA_INSTRUCTION');
  return `0x${unsnappy(raw.subarray(12, 12 + length)).toString('hex')}`;
};
export const reportOf = data => payloadOf(base58(data));

// What the top-level instructions of a transaction that call a VERIFYING method decode to, whatever their feed.
// Instructions that do not decode (malformed data) are skipped. A transaction is at most 1,232 bytes: an answer
// whose instruction data alone is longer is no transaction (a hostile endpoint) and is not decoded at all.
export const reportsIn = transaction => {
  const message = transaction?.transaction?.message, instructions = message?.instructions, keys = message?.accountKeys;
  if (!Array.isArray(instructions) || !Array.isArray(keys) || instructions.reduce((n, i) => n + (typeof i?.data === 'string' ? i.data.length : 0), 0) > 2048) return [];
  return instructions.flatMap(instruction => {
    try {
      const raw = base58(instruction?.data);
      requireCondition(VERIFYING.has(`${keys[instruction.programIdIndex]} ${raw.subarray(0, 8).toString('hex')}`), 'STREAMS_SOLANA_INSTRUCTION');
      return [payloadOf(raw)];
    } catch { return []; }
  });
};

export class SolanaReports {
  // Seconds the copy asked for without a boundary may be old for the feed to count as served (main.mjs,
  // KEEPER_STREAMS_STALE). That copy covers the last five-minute boundary at least 30 s old: at most 330 s.
  latestWithin = 600;
  #url; #fetch; #seen = new Map(); #missed = new Map(); #offered = new Map(); #served = new Map(); #until = 0; #failures = 0; #code;
  constructor({ url = SOLANA_RPC, fetchImpl = fetch } = {}) {
    // An operator's endpoint may carry an access key: it comes from the settings file and is never printed.
    requireCondition(typeof url === 'string' && /^https:\/\/\S+$/.test(url), 'KEEPER_RPC_CONFIG');
    this.#url = url; this.#fetch = fetchImpl;
  }

  // One JSON-RPC call. After a failure (a 429 above all: the public endpoint allows about one call per second and
  // method) the endpoint is left alone for 1 s, doubling to 15 s (the keeper's longest wait while an opening depends
  // on a boundary, main.mjs), or as long as its Retry-After says (at most a minute), and meanwhile every call fails at
  // once with the same code. Codes are fixed; provider text never becomes one.
  async #call(method, params) {
    if (Date.now() < this.#until) throw new Error(this.#code);
    const fail = (code, wait) => {
      this.#failures += 1; this.#code = code; this.#until = Date.now() + Math.min(wait ?? Math.min(2 ** this.#failures * 500, 15000), 60000);
      return new Error(code);
    };
    let response, data;
    try {
      response = await this.#fetch(this.#url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    } catch { throw fail('STREAMS_SOLANA_TRANSPORT'); }
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw fail(`STREAMS_SOLANA_HTTP_${response.status}`, retryAfter(response.headers)); }
    try { data = await boundedJSON(response, 1 << 20); } catch { throw fail('STREAMS_SOLANA_RESPONSE'); }
    if (!data || typeof data !== 'object' || data.error !== undefined || !('result' in data)) throw fail('STREAMS_SOLANA_RESPONSE');
    this.#failures = 0;
    return data.result;
  }

  // A source's transactions, newest first: one page of 25 and, for an older boundary, pages of 1,000 back past it.
  // complete: the list reaches back to before the boundary, or the source's history ends.
  async #history(address, boundary) {
    const list = [];
    for (let page = 0; page < PAGES; page++) {
      const limit = page ? 1000 : 25, before = list.at(-1)?.signature;
      const entries = await this.#call('getSignaturesForAddress', [address, { limit, commitment: 'confirmed', ...(before ? { before } : {}) }]);
      requireCondition(Array.isArray(entries) && entries.length <= limit && entries.every(e => typeof e?.signature === 'string' && SIGNATURE.test(e.signature)
        && (e.blockTime === null || Number.isSafeInteger(e.blockTime))), 'STREAMS_SOLANA_RESPONSE');
      list.push(...entries);
      const last = entries.at(-1)?.blockTime;
      if (entries.length < limit || Number.isSafeInteger(last) && last < boundary - EARLY) return { list, complete: true };
    }
    return { list, complete: false };
  }

  // A transaction's report payloads. Read once: a transaction does not change. One not served (a node behind the one
  // that listed it) is asked again on later calls, and after three such answers passed over as holding none, so that
  // an endpoint that never serves it cannot hide the transactions after it for good.
  async #payloads(signature) {
    if (this.#seen.has(signature)) return this.#seen.get(signature);
    const transaction = await this.#call('getTransaction', [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    const missed = transaction === null ? (this.#missed.get(signature) ?? 0) + 1 : 0;
    if (missed && missed < 3) { remember(this.#missed, signature, missed); return []; }
    this.#missed.delete(signature);
    return remember(this.#seen, signature, missed ? [] : reportsIn(transaction));
  }

  // The first report for feedId, in the order of `entries`, that `wanted` accepts. Only transactions that succeeded
  // count (their program verified the report on Solana); another feed or anything else is passed over.
  async #first(entries, feedId, wanted) {
    let fetched = 0;
    for (const entry of entries) {
      if (entry.err !== null) continue;
      if (!this.#seen.has(entry.signature) && fetched++ >= TRANSACTIONS) return undefined;
      for (const payload of await this.#payloads(entry.signature)) {
        let observation; try { observation = decodeReport(payload, feedId); } catch { continue; }
        if (wanted(observation)) return { payload, observation };
      }
    }
    return undefined;
  }

  // Distinct copies covering a boundary, the primary's first; the backup is searched only while `enough` says no.
  async #copies(feedId, boundary, window, enough) {
    const copies = [];
    let short = false;
    for (const [name, address] of Object.entries(SOURCES)) {
      if (enough(copies)) break;
      const { list, complete } = await this.#history(address, boundary);
      short ||= !complete;
      const near = list.filter(e => e.blockTime === null || e.blockTime >= boundary - EARLY && e.blockTime <= boundary + LATE).reverse();
      const copy = await this.#first(near, feedId, observation => covers(observation, boundary, window));
      if (copy && !copies.some(c => c.payload === copy.payload)) copies.push({ ...copy, source: name });
    }
    // None yet (a retry, like the API's miss), or the boundary is older than the history searched.
    requireCondition(copies.length, short ? 'STREAMS_SOLANA_HISTORY' : 'STREAMS_NO_COVERING_REPORT');
    return copies;
  }

  // With a boundary: a copy whose signed window covers it, the primary's first. Asked again for the same boundary
  // (main.mjs asks again only when the Base adapter refused the copy it was given) it offers a copy it has not
  // offered yet, the backup's if need be, and once all were offered starts over. Without one (readiness for new
  // rounds): the copy covering the last five-minute boundary at least 30 s old, which both sources post within
  // seconds (the primary at each, the backup every minute), so it is among the first transactions after it.
  async report(feedId, boundary, window = 60) {
    requireCondition(/^0x0003[0-9a-f]{60}$/.test(feedId), 'STREAMS_FEED');
    requireCondition(boundary === undefined || Number.isSafeInteger(boundary) && boundary > 0 && boundary <= 0xffffffff, 'STREAMS_BOUNDARY');
    let copy;
    if (boundary === undefined) {
      const recent = Math.floor((Date.now() / 1000 - 30) / 300) * 300;
      try { [copy] = await this.#copies(feedId, recent, window, copies => copies.length > 0); }
      catch (error) { throw error.message === 'STREAMS_NO_COVERING_REPORT' ? new Error('STREAMS_SOLANA_NO_RECENT_REPORT') : error; }
    } else {
      const key = `${feedId}:${boundary}`, offered = this.#offered.get(key) ?? new Set();
      const copies = await this.#copies(feedId, boundary, window, found => found.some(c => !offered.has(c.payload)));
      copy = copies.find(c => !offered.has(c.payload));
      if (!copy) { offered.clear(); [copy] = copies; }
      offered.add(copy.payload); remember(this.#offered, key, offered, 256);
    }
    this.#served.set(feedId, { ...this.served(feedId), [copy.source]: Date.now() });
    return { payload: copy.payload, observation: copy.observation };
  }

  // Per source, when it last supplied the copy returned for feedId (milliseconds), or null: the status line.
  served(feedId) { return { primary: null, backup: null, ...this.#served.get(feedId) }; }
}

// The paid client behind the copies (KEEPER_REPORT_SOURCE=solana with Chainlink credentials, main.mjs): for a
// boundary still asked for FALLBACK seconds after it (no copy yet, or every copy refused by the Base adapter) it is
// asked first and the copies second; before that only the copies are. Readiness asks the copies, then the paid client.
export function withFallback(free, paid) {
  const used = new Map();
  const ask = async (source, feedId, boundary, window) => {
    const report = await source.report(feedId, boundary, window); if (source === paid) used.set(feedId, Date.now()); return report;
  };
  return {
    latestWithin: free.latestWithin,
    served: feedId => ({ ...free.served(feedId), chainlink: used.get(feedId) ?? null }),
    async report(feedId, boundary, window) {
      if (boundary !== undefined && Date.now() / 1000 < boundary + FALLBACK) return free.report(feedId, boundary, window);
      const [first, second] = boundary === undefined ? [free, paid] : [paid, free];
      try { return await ask(first, feedId, boundary, window); }
      catch (error) { return ask(second, feedId, boundary, window).catch(() => { throw error; }); }
    },
  };
}

// A bounded memo: the oldest entry leaves once it holds more than `limit`. Returns the value.
function remember(map, key, value, limit = 4096) {
  map.set(key, value); if (map.size > limit) map.delete(map.keys().next().value);
  return value;
}
