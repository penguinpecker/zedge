// EVALUATION ONLY: software TEE, no attestation, test token, fixture oracle; sender,
// amount and time are trusted from the manager. Not private, not secure, not
// production-ready.
//
// Repeats a fixture of host calls on ONE guest instance, the way the executor
// reuses its cached instance, and fails if linear memory keeps growing.
// TinyGo's collector takes constants in the wasm data section for pointers, so
// a dead buffer one of them points into is never freed; with buffers much
// above half a megabyte that outruns reuse and memory doubles without limit.
// The fixture holds states at the guest's size bound. Every result must also
// equal what the native adapter returned. Run by TestGuestSoak:
//   node testdata/soak.mjs build/zedge_guest.wasm build/soak.json [rounds]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const fixture = JSON.parse(await readFile(process.argv[3], 'utf8'));
const rounds = Number(process.argv[4] || 40);
const bytes = (v) => Buffer.from(v ?? '', 'base64');
const app = BigInt.asIntN(64, BigInt(fixture.application));

let memory, random = (target) => target.fill(7);
const view = () => new DataView(memory.buffer);
const none = (a, b) => { view().setUint32(a, 0, true); view().setUint32(b, 0, true); return 0; };
const wasi = {
  fd_write: (fd, iovs) => { // TinyGo prints only when it panics
    throw new Error(`guest wrote: ${Buffer.from(memory.buffer, view().getUint32(iovs, true), view().getUint32(iovs + 4, true))}`);
  },
  proc_exit: (code) => { throw new Error(`guest exited with ${code}`); },
  clock_time_get: (id, precision, out) => { view().setBigUint64(out, 0n, true); return 0; },
  random_get: (pointer, length) => random(new Uint8Array(memory.buffer, pointer, length)) === null ? 29 : 0,
  args_sizes_get: none, args_get: () => 0, environ_sizes_get: none, environ_get: () => 0,
};
const { exports: guest } = await WebAssembly.instantiate(await WebAssembly.compile(await readFile(process.argv[2])), { wasi_snapshot_preview1: wasi });
memory = guest.memory;

// One call as the host makes it: allocate and fill each input, call, copy the
// length-prefixed result out, free the result and then the inputs.
const call = (c) => {
  const held = [];
  const put = (b) => {
    if (!b.length) return 0;
    const pointer = guest.allocate(b.length);
    assert.notEqual(pointer, 0, `allocate(${b.length})`);
    new Uint8Array(memory.buffer, pointer >>> 0, b.length).set(b);
    held.push([pointer, b.length]);
    return pointer;
  };
  let pointer;
  if (c.call === 'deploy') pointer = guest.deploy(app, put(c.payload), c.payload.length);
  else if (c.call === 'deposit') { const a = put(c.sender), b = put(c.token), d = put(c.state), e = put(c.value); pointer = guest.deposit(app, a, c.sender.length, b, c.token.length, e, c.value.length, d, c.state.length); }
  else if (c.call === 'process') { const a = put(c.sender), b = put(c.payload), d = put(c.state); pointer = guest.process_request(app, a, c.sender.length, 1, b, c.payload.length, d, c.state.length); }
  else { const b = put(c.payload), d = put(c.state); pointer = guest.trusted_request(app, b, c.payload.length, d, c.state.length); }
  const length = view().getUint32(pointer >>> 0, true);
  const out = Buffer.from(new Uint8Array(memory.buffer, (pointer >>> 0) + 4, length));
  guest.deallocate(pointer, 4 + length);
  for (const [p, n] of held.reverse()) guest.deallocate(p, n);
  return out;
};

// The deployment's salt is whatever the host's random source gave, and no
// deployment starts when that source fails or gives nothing.
const deploy = { call: 'deploy', payload: bytes(fixture.params) };
const salt = () => { const r = JSON.parse(call(deploy)); return r.error ?? JSON.parse(bytes(r.state)).salt; };
assert.equal(salt(), '07'.repeat(32));
random = (target) => target.fill(9);
assert.equal(salt(), '09'.repeat(32));
random = () => null;
assert.equal(salt(), 'zedge: internal error');
random = (target) => target.fill(0);
assert.equal(salt(), 'zedge: internal error');
random = (target) => target.fill(7);

// The guest hands out nothing larger than a state at the bound.
const largest = guest.allocate(fixture.bound);
assert.notEqual(largest, 0);
guest.deallocate(largest, fixture.bound);
assert.equal(guest.allocate(fixture.bound + 1), 0);

const calls = fixture.calls.map((c) => ({ ...c, sender: bytes(c.sender), token: bytes(c.token), value: bytes(c.value), payload: bytes(c.payload), state: bytes(c.state), expect: bytes(c.expect) }));
const size = [], slowest = {}, started = Date.now();
for (let round = 0; round < rounds; round++) {
  for (const c of calls) {
    const began = Date.now();
    assert.ok(call(c).equals(c.expect), `round ${round}: "${c.name}" differs from the native adapter`);
    slowest[c.name] = Math.max(slowest[c.name] ?? 0, Date.now() - began);
  }
  size.push(memory.buffer.byteLength / 2 ** 20);
}
const settled = size[Math.floor(rounds / 4)], last = size[rounds - 1];
const top = Object.entries(slowest).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, ms]) => `${name} ${ms} ms`).join('; ');
console.log(`${rounds} rounds of ${calls.length} calls, states up to ${Math.max(...calls.map((c) => c.state.length))} bytes: linear memory ${[...new Set(size)].join(' -> ')} MiB; slowest calls: ${top}; ${Date.now() - started} ms`);
assert.equal(last, settled, `linear memory grew from ${settled} to ${last} MiB after the first quarter of the run`);
assert.ok(last <= fixture.ceilingMiB, `linear memory is ${last} MiB, above the ${fixture.ceilingMiB} MiB this bound was measured at`);
