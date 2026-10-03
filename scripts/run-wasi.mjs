// Run the local conformance binary without network or filesystem preopens.
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
const path = process.argv[2];
if (!path || process.argv.length !== 3) throw new Error('Usage: node scripts/run-wasi.mjs path/to/scenario.wasm');
const wasi = new WASI({ version: 'preview1', args: ['scenario'], env: {}, preopens: {}, returnOnExit: true });
const wasm = await WebAssembly.compile(await readFile(path));
const instance = await WebAssembly.instantiate(wasm, wasi.getImportObject());
process.exitCode = wasi.start(instance);
