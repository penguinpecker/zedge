import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbiParameters, toHex, type Hex } from "viem";
import { endpointAbi, engineRound, parseOrderbookManifest, type VerifiedOrderbook } from "./orderbook-manifest.ts";
import { confirmSettle, readApi, sharedLive, type SettleRef } from "./read-api.ts";
import { SUBTYPES } from "./vault.ts";

const book = parseOrderbookManifest(JSON.parse(await readFile(new URL("./testdata/orderbook-configured.json", import.meta.url), "utf8"))) as VerifiedOrderbook["manifest"];
const H = (n: number) => keccak256(toHex(`h${n}`));
const START = 1_791_414_000, ROUND_ID = engineRound(book, START).spec.registryRoundId;
const ref = (over: Partial<Record<string, unknown>> = {}) => ({ kind: 1, outcome: 0, price: "83188953042209250000000", observationsTimestamp: START, reportHash: H(1), source: 1, block: 28_016_723, txHash: H(2), logIndex: 2, ...over });
const liveBody = (over: Record<string, unknown> = {}) => ({ head: { block: 28_017_421, time: START + 704 }, clock: null,
  rounds: [{ start: START - 900, registryRoundId: H(3), open: null, settle: null }, { start: START, registryRoundId: ROUND_ID, open: ref(), settle: null }, { start: START + 900, registryRoundId: H(4), open: null, settle: null }],
  price: [START + 660, 83_492.71], ...over });
const answering = (body: unknown, ok = true, seen: { url: string; init: RequestInit }[] = []) => readApi(async (url, init) => { seen.push({ url, init }); return { ok, json: async () => body }; });

test("live, rounds and account answers are checked field by field; anything malformed, refused or unanswered is null, the signal to read the chain", async () => {
  const live = await answering(liveBody()).live();
  assert.deepEqual(live?.price, { t: (START + 660) * 1000, p: 83_492.71 });
  assert.deepEqual(live?.rounds[1].open, { ...ref(), price: 83188953042209250000000n });
  assert.equal(live?.rounds[0].open, null);
  const broken = [
    liveBody({ head: { block: -1, time: 1 } }),
    liveBody({ rounds: Array(5).fill(liveBody().rounds[0]) }),
    liveBody({ rounds: [{ ...liveBody().rounds[1], open: ref({ reportHash: "0x1234" }) }] }),
    liveBody({ rounds: [{ ...liveBody().rounds[1], open: ref({ price: "8.3e22" }) }] }),
    liveBody({ rounds: [{ ...liveBody().rounds[1], start: START + 1 }] }),
    liveBody({ price: [START + 1, 1] }),
  ];
  for (const body of broken) assert.equal(await answering(body).live(), null, JSON.stringify(body).slice(0, 80));
  assert.equal(await answering(liveBody(), false).live(), null, "a refusal");
  assert.equal(await readApi(async () => { throw new Error("offline"); }).live(), null, "no answer");
  assert.equal((await answering({ head: { block: 1, time: 1 }, rounds: liveBody().rounds }).rounds())?.rounds.length, 3);

  // The account: its address in the POST body only, never in the URL; receipts decoded from base64 to the exact bytes.
  const receipt = Uint8Array.from({ length: 8_220 }, (_, i) => i % 251), seen: { url: string; init: RequestInit }[] = [];
  const request = { requestId: H(5), block: 9, logIndex: 1, txHash: H(6), completed: { block: 10, txHash: H(7), status: 0, errorCode: 0, errorMessage: "" }, ciphertexts: [Buffer.from(receipt).toString("base64")] };
  const page = await answering({ head: { block: 11, time: 1 }, more: true, requests: [request, { ...request, requestId: H(8), completed: null, ciphertexts: [] }] }, true, seen)
    .account("0x00000000000000000000000000000000000000aa", { block: 9, logIndex: 0 }, 20);
  assert.deepEqual(seen.map((x) => [x.url, x.init.method, x.init.cache, x.init.credentials, JSON.parse(String(x.init.body))]),
    [["/v1/account", "POST", "no-store", "omit", { address: "0x00000000000000000000000000000000000000aa", before: { block: 9, logIndex: 0 }, limit: 20 }]]);
  assert.deepEqual(page?.requests[0].ciphertexts[0], receipt);
  assert.deepEqual([page?.more, page?.requests[0].block, page?.requests[0].completed?.txHash, page?.requests[1].completed], [true, 9n, H(7), null]);
  const oversized = { ...request, ciphertexts: [Buffer.alloc(16_385).toString("base64")] };
  assert.equal(await answering({ head: { block: 1, time: 1 }, more: false, requests: [oversized] }).account("0x00000000000000000000000000000000000000aa"), null, "a receipt over 16 KiB");
});

test("the house's quotes are checked field by field; a malformed one costs only the quotes, never the rest of the live read", async () => {
  // The wire's shares are whole shares, as the house bot sends them (services/market-maker houseQuotes); the page keeps share atoms.
  const q = (cents: number, shares: unknown = 10) => ({ cents, shares });
  const good = { at: (START + 700) * 1000, start: START, up: { ask: q(14), bid: q(12, 5.5) }, down: { ask: null, bid: q(84, 0.002) } };
  assert.deepEqual((await answering(liveBody({ house: good })).live())?.house,
    { ...good, up: { ask: { cents: 14, shares: 10_000_000 }, bid: { cents: 12, shares: 5_500_000 } }, down: { ask: null, bid: { cents: 84, shares: 2_000 } } });
  assert.equal((await answering(liveBody()).live())?.house, null, "an indexer without the field");
  const broken = [
    { ...good, start: START + 1 }, { ...good, at: 0 }, { ...good, at: "1" }, { ...good, down: undefined }, [good],
    { ...good, up: { ask: q(0), bid: null } }, { ...good, up: { ask: q(100), bid: null } }, { ...good, up: { ask: q(14.5), bid: null } },
    { ...good, up: { ask: q(14, 0.0015), bid: null } }, { ...good, up: { ask: q(14, 5.0000004), bid: null } }, { ...good, up: { ask: q(14, 0), bid: null } },
    { ...good, up: { ask: q(14, -1), bid: null } }, { ...good, up: { ask: q(14, "10"), bid: null } }, { ...good, up: { ask: q(14) } },
    { ...good, up: { ask: q(12), bid: q(12) } },
  ];
  for (const house of broken) {
    const live = await answering(liveBody({ house })).live();
    assert.deepEqual([live?.house, live?.rounds.length], [null, 3], JSON.stringify(house));
  }
});

test("the page's live read is shared: one request per 1.5 s, however many parts of the page ask", async () => {
  let reads = 0, t = 0;
  const live = sharedLive(async () => { reads++; return null; }, () => t);
  await Promise.all([live(), live()]);
  t += 1_499; await live();
  assert.equal(reads, 1);
  t += 1; await live();
  assert.equal(reads, 2);
});

test("an engine record from the API is used only when its receipt on chain holds exactly that AppEvent", async () => {
  const words = (over: Partial<{ round: Hex; price: bigint }> = {}) => encodeAbiParameters(parseAbiParameters("bytes32, uint256, uint256, uint256, uint256, bytes32, uint256"),
    [over.round ?? ROUND_ID, 1n, 0n, over.price ?? 83188953042209250000000n, BigInt(START), H(1), 1n]);
  const log = (over: Partial<{ app: bigint; subtype: Hex; data: Hex; address: string; logIndex: number }> = {}) => ({
    address: over.address ?? book.endpoint.address, logIndex: over.logIndex ?? 2, blockNumber: 28_016_723n, transactionHash: H(2),
    topics: encodeEventTopics({ abi: endpointAbi, eventName: "AppEvent", args: { applicationId: over.app ?? BigInt(book.application.id), requestId: H(9), eventSubType: over.subtype ?? SUBTYPES.settle } }),
    data: encodeAbiParameters(parseAbiParameters("bytes"), [over.data ?? words()]) });
  const chain = (logs: unknown[], status = "success", blockNumber = 28_016_723n) => ({ getTransactionReceipt: async () => ({ status, blockNumber, logs }) }) as unknown as Parameters<typeof confirmSettle>[0];
  const open: SettleRef = { kind: 1, outcome: 0, price: 83188953042209250000000n, observationsTimestamp: START, reportHash: H(1), source: 1, block: 28_016_723, txHash: H(2), logIndex: 2 };
  assert.equal(await confirmSettle(chain([log({ logIndex: 0, subtype: SUBTYPES.clock }), log()]), book, open, ROUND_ID), true);
  const refused: [string, Parameters<typeof confirmSettle>[0], SettleRef, Hex][] = [
    ["another price than the chain's", chain([log()]), { ...open, price: open.price + 1n }, ROUND_ID],
    ["another round", chain([log({ data: words({ round: H(3) }) })]), open, ROUND_ID],
    ["asked for another round", chain([log()]), open, H(3)],
    ["another subtype", chain([log({ subtype: SUBTYPES.credit })]), open, ROUND_ID],
    ["another application", chain([log({ app: 1n })]), open, ROUND_ID],
    ["another contract", chain([log({ address: "0x000000000000000000000000000000000000dead" })]), open, ROUND_ID],
    ["another log index", chain([log({ logIndex: 3 })]), open, ROUND_ID],
    ["a reverted transaction", chain([log()], "reverted"), open, ROUND_ID],
    ["another block", chain([log()], "success", 28_016_724n), open, ROUND_ID],
  ];
  for (const [why, client, r, id] of refused) assert.equal(await confirmSettle(client, book, r, id), false, why);
});
