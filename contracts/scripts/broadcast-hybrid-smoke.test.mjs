import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePublishReceipt } from './broadcast-hybrid-smoke.mjs';

// Canonical receipt regression: no RPC, artifacts, environment, keys or signing.
function fixture() {
  const hash = `0x${'a'.repeat(64)}`; const blockHash = `0x${'b'.repeat(64)}`;
  const from = `0x${'1'.repeat(40)}`;
  const transaction = { to: `0x${'2'.repeat(40)}`, nonce: 3, data: '0x1234', gas: 300000n, maxFeePerGas: 500n, maxPriorityFeePerGas: 2n };
  const receipt = { transactionHash: hash, status: 'success', blockNumber: 30n, blockHash };
  const tx = { ...transaction, hash, from, input: transaction.data, blockHash, blockNumber: 30n, value: 0n, chainId: 8453, type: 'eip1559' };
  return { receipt, tx, block: { hash: blockHash, number: 30n }, head: 31n, hash, transaction, from };
}
function validate(f) { return validatePublishReceipt(f.receipt, f.tx, f.block, f.head, f.hash, f.transaction, f.from); }

test('accepts an exact canonical two-confirmation publish transaction', () => {
  assert.doesNotThrow(() => validate(fixture()));
});

test('rejects zero, absent or conflicting receipt/header/transaction block hashes', () => {
  for (const target of ['receipt', 'tx', 'block']) {
    for (const value of [`0x${'0'.repeat(64)}`, undefined, null, `0x${'c'.repeat(64)}`]) {
      const f = fixture(); f[target][target === 'block' ? 'hash' : 'blockHash'] = value;
      assert.throws(() => validate(f));
    }
  }
});

test('rejects one confirmation, failed execution or mismatched transaction location', () => {
  for (const mutate of [f => { f.head = 30n; }, f => { f.receipt.status = 'reverted'; }, f => { f.tx.blockNumber = 29n; }, f => { f.block.number = 29n; }]) {
    const f = fixture(); mutate(f); assert.throws(() => validate(f));
  }
});

test('rejects changed sender, target, nonce, payload, value, chain or fee caps', () => {
  for (const [key, value] of Object.entries({ hash: `0x${'c'.repeat(64)}`, from: `0x${'3'.repeat(40)}`, to: `0x${'3'.repeat(40)}`,
    nonce: 4, input: '0x5678', value: 1n, chainId: 26514, type: 'legacy', gas: 300001n, maxFeePerGas: 501n, maxPriorityFeePerGas: 3n })) {
    const f = fixture(); f.tx[key] = value; assert.throws(() => validate(f));
  }
});
