// Calls the built guest's exports the way no honest host does: pointers the
// module never handed out, impossible lengths, a free before anything else.
// Each must come back as an error result. A trap, or any guest output, fails.
// Run by TestGuestShim: node testdata/shim.mjs build/zedge_guest.wasm
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let memory;
const view = () => new DataView(memory.buffer);
const none = (a, b) => { view().setUint32(a, 0, true); view().setUint32(b, 0, true); return 0; };
const wasi = {
  fd_write: (fd, iovs) => { // TinyGo prints only when it panics
    throw new Error(`guest wrote: ${Buffer.from(memory.buffer, view().getUint32(iovs, true), view().getUint32(iovs + 4, true))}`);
  },
  proc_exit: (code) => { throw new Error(`guest exited with ${code}`); },
  clock_time_get: (id, precision, out) => { view().setBigUint64(out, 0n, true); return 0; },
  random_get: (pointer, length) => { new Uint8Array(memory.buffer, pointer, length).fill(7); return 0; },
  args_sizes_get: none, args_get: () => 0, environ_sizes_get: none, environ_get: () => 0,
};
const { exports: guest } = await WebAssembly.instantiate(await WebAssembly.compile(await readFile(process.argv[2])), { wasi_snapshot_preview1: wasi });
memory = guest.memory;

// Every result is [uint32 little-endian length][JSON]; the host frees it.
const result = (pointer) => {
  assert.notEqual(pointer, 0);
  const length = view().getUint32(pointer, true);
  const body = JSON.parse(Buffer.from(memory.buffer, pointer + 4, length).toString());
  guest.deallocate(pointer, 4 + length);
  assert.equal(body.fuel, '0x1');
  return body;
};
const bad = 'zedge: bad buffer';

guest.deallocate(12345, 10); // the first call of all, for a buffer that never existed
for (const size of [0, -1, 512 * 1024 + 1, 0x7fffffff]) assert.equal(guest.allocate(size), 0, `allocate(${size})`);

const held = guest.allocate(8);
assert.notEqual(held, 0);
assert.equal(result(guest.deploy(7n, 4096, 16)).error, bad);
assert.equal(result(guest.deploy(7n, 0, 5)).error, bad);
assert.equal(result(guest.deploy(7n, held, 9)).error, bad);
assert.equal(result(guest.deploy(7n, held, -1)).error, bad);
assert.equal(result(guest.deploy(7n, held + 1, 4)).error, bad);
assert.equal(result(guest.deposit(7n, held, 8, held, 8, held, 8, 1, 1)).error, bad);
assert.equal(result(guest.process_request(7n, held, 8, 1, 99, 3, held, 8)).error, bad);
assert.equal(result(guest.trusted_request(7n, -5, 3, held, 8)).error, bad);
guest.deallocate(held, 8);
assert.equal(result(guest.deploy(7n, held, 8)).error, bad); // freed

// Empty input is how the host passes nothing: an ordinary refusal.
assert.equal(result(guest.deploy(7n, 0, 0)).error, 'zedge: malformed parameters');
assert.equal(result(guest.deposit(7n, 0, 0, 0, 0, 0, 0, 0, 0)).error, 'zedge: unsupported token'); // custody is the Base vault
assert.equal(result(guest.process_request(7n, 0, 0, 1, 0, 0, 0, 0)).error, 'zedge: invalid state');
assert.equal(result(guest.process_request(7n, 0, 0, 2, 0, 0, 0, 0)).error, 'zedge: unsupported request type');
assert.equal(result(guest.trusted_request(7n, 0, 0, 0, 0)).error, 'zedge: invalid state');
assert.deepEqual(result(guest.load_module(-1n)), { state: null, events: null, appEvents: null, withdrawals: null, fuel: '0x1' });
console.log('shim ok');
