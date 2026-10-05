/** Canonical-receipt validation of the one-time Base smoke publication of 2026-10-04 (deployment/MAINNET.md).
 * That publication was single-use and bound to the first Base nonce after the route deployment, so its
 * planner and sender are gone; the keeper publishes boundaries now. Pure: no RPC, files, keys or signing.
 */
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const demand = condition => { if (!condition) throw new Error('Smoke preflight mismatch'); };

export function validatePublishReceipt(receipt, tx, block, head, hash, transaction, from) {
  const validHash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) && !/^0x0{64}$/i.test(value);
  demand(validHash(receipt.blockHash) && validHash(block.hash) && validHash(tx.blockHash));
  demand(eq(receipt.transactionHash, hash) && receipt.status === 'success');
  demand(eq(block.hash, receipt.blockHash) && eq(tx.blockHash, receipt.blockHash));
  demand(head >= receipt.blockNumber + 1n && tx.blockNumber === receipt.blockNumber && block.number === receipt.blockNumber);
  demand(eq(tx.hash, hash) && eq(tx.from, from) && eq(tx.to, transaction.to));
  demand(tx.nonce === transaction.nonce && tx.value === 0n && tx.chainId === 8453 && tx.type === 'eip1559');
  demand(eq(tx.input, transaction.data) && tx.gas === transaction.gas);
  demand(tx.maxFeePerGas === transaction.maxFeePerGas && tx.maxPriorityFeePerGas === transaction.maxPriorityFeePerGas);
}
