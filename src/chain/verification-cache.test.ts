import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createVerificationCache, verificationIsFresh, VERIFICATION_TTL_MS } from "./verification-cache.ts";

test("read-only checks reuse an exact manifest for less than 120 seconds, never sliding the expiry", async () => {
  let now = 100, wall = 1_000_000, reads = 0;
  const cache = createVerificationCache<number>(() => now, () => wall);
  const load = async () => ++reads;
  const first = await cache.read(26514, "release-a", load);
  now += VERIFICATION_TTL_MS - 1; wall -= 999_000;
  assert.equal(await cache.read(26514, "release-a", load), first);
  assert.equal(first.checkedAt, 1_000_000);
  assert.equal(verificationIsFresh(first, now), true);
  now++;
  assert.equal(verificationIsFresh(first, now), false);
  assert.equal((await cache.read(26514, "release-a", load)).value, 2);
  assert.equal(verificationIsFresh(first, 99), false);
});

test("network and every manifest byte isolate cached and pending verification", async () => {
  const cache = createVerificationCache<string>(() => 0);
  const one = await cache.read(26514, '{"release":"a","hash":"1"}', async () => "mainnet");
  const two = await cache.read(2651420, '{"release":"a","hash":"1"}', async () => "testnet");
  const changed = await cache.read(26514, '{"release":"a","hash":"2"}', async () => "changed");
  assert.deepEqual([one.value, two.value, changed.value], ["mainnet", "testnet", "changed"]);
  await assert.rejects(cache.read(1, "release-a", async () => "wrong"), /network/);
});

test("refresh invalidates success but shares pending work; older manifests cannot overwrite newer ones", async () => {
  const cache = createVerificationCache<string>(() => 0);
  let finish!: (value: string) => void, loads = 0;
  const old = cache.read(26514, "old", () => { loads++; return new Promise((resolve) => { finish = resolve; }); });
  await Promise.resolve();
  cache.invalidate(26514);
  const same = cache.read(26514, "old", async () => { throw new Error("duplicate"); });
  await cache.read(26514, "new", async () => "new");
  finish("old");
  assert.equal(await old, await same);
  assert.equal(loads, 1);
  assert.equal((await cache.read(26514, "new", async () => "overwritten")).value, "new");
  cache.invalidate(26514);
  assert.equal((await cache.read(26514, "new", async () => "refreshed")).value, "refreshed");
});

test("errors and verification that outlives its own window never leave a usable cached result", async () => {
  let now = 0;
  const cache = createVerificationCache<boolean>(() => now);
  await assert.rejects(cache.read(26514, "a", async () => { throw new Error("offline"); }), /offline/);
  assert.equal((await cache.read(26514, "a", async () => true)).value, true);
  cache.invalidate(26514);
  await assert.rejects(cache.read(26514, "a", async () => { now = VERIFICATION_TTL_MS; return true; }), /expired/);
  assert.equal((await cache.read(26514, "a", async () => false)).value, false);
});
