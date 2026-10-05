import { toFunctionSelector } from 'viem';

// One taxonomy for every failure the run loop can meet. Each is exactly one of:
//   done  - somebody already did it: re-read state and move on
//   retry - not yet, or temporarily impossible: a later tick tries again, with backoff
//   skip  - this intent cannot succeed as planned: leave it, everything else continues
//   stop  - continuing could double-spend, overspend, or act for a deployment or signer it cannot identify
// Only `stop` ends the process. Codes are fixed strings; provider text (which can carry a private RPC URL) never becomes one.
const reverts = Object.fromEntries(Object.entries({
  done: ['RoundExists(bytes32)', 'OpeningAlreadyRecorded()', 'AlreadyFinalized()'],
  skip: ['ConflictingObservation()'],
  retry: ['UnknownRound(bytes32)', 'OpeningMissing()', 'OutsideOpeningWindow()', 'RoundNotEnded()', 'TimeoutNotReached()',
    'ClosingEvidenceAvailable()', 'InvalidSchedule()', 'InvalidObservation()', 'MissingObservation()', 'InvalidWindow()',
    'InvalidEvidence()', 'InvalidOracleResponse()'],
}).flatMap(([kind, signatures]) => signatures.map(signature => [toFunctionSelector(signature),
  { class: kind, code: `REVERT_${signature.split('(')[0].replace(/(?<!^)[A-Z]/g, '_$&').toUpperCase()}` }])));

const retry = new Set(['KEEPER_CHAIN_CLOCK', 'KEEPER_CLOCK', 'KEEPER_INTEGER', 'KEEPER_PHASE', 'KEEPER_FEE_CAP', 'KEEPER_GAS_CAP', 'KEEPER_BUDGET', 'KEEPER_BALANCE',
  'KEEPER_TX_PENDING', 'KEEPER_NONCE_BEHIND', 'KEEPER_PRESEND_STALE', 'KEEPER_SUBMITTED_HASH', 'KEEPER_TX_FAILED', 'KEEPER_TX_CANONICAL',
  'KEEPER_TX_MISMATCH', 'KEEPER_ATTEMPT_SETTLING', 'KEEPER_RETRY_SPACING', 'KEEPER_BASE_BEHIND_BOUNDARY', 'KEEPER_STREAMS_STALE',
  'KEEPER_RPC_RECEIPTS', 'KEEPER_REORGANISED', 'KEEPER_SIGNER_UNCONFIRMED']);
const skip = new Set(['KEEPER_ATTEMPTS_EXHAUSTED', 'KEEPER_RESENDS_EXHAUSTED', 'KEEPER_STREAMS_AUTHENTICATION', 'STREAMS_BOUNDARY_WINDOW', 'STREAMS_FEED', 'STREAMS_BOUNDARY', 'STREAMS_WINDOW']);
const stop = new Set(['STREAMS_PATH', 'STREAMS_USERNAME', 'STREAMS_SECRET', 'STREAMS_CLOCK', 'STREAMS_ORIGIN']);

function retryAfter(headers) {
  const value = headers?.get?.('retry-after'); if (!value) return undefined;
  const wait = /^[0-9]+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(wait) && wait > 0 ? wait : undefined;
}

export function classify(error) {
  const message = String(error?.message ?? '');
  if (/^(KEEPER|STREAMS|RPC|REVERT|UNEXPECTED)_[A-Z0-9_]{1,70}$/.test(message)) {
    // 400/401/403: the request itself was refused, and Chainlink checks only the HMAC identity and its timestamp.
    const code = /^STREAMS_HTTP_40[013]$/.test(message) ? `${message}_CHECK_CREDENTIALS_AND_CLOCK` : message;
    // An unlisted KEEPER_ code is one of this service's own invariants: fail closed.
    return { class: retry.has(message) ? 'retry' : skip.has(message) ? 'skip' : stop.has(message) || message.startsWith('KEEPER_') ? 'stop' : 'retry', code };
  }
  const causes = []; for (let e = error; e && causes.length < 16; e = e.cause) causes.push(e);
  const http = causes.find(e => e.name === 'HttpRequestError');
  if (http) return { class: 'retry', code: `RPC_HTTP_${Number.isInteger(http.status) ? http.status : 'ERROR'}`, rpc: true, retryAfter: retryAfter(http.headers) };
  // The node's answer that the call needs more gas than it allows (Base: "out of gas: gas required exceeds: 16777216"
  // to an estimate above its per-transaction cap; geth and Anvil say "gas required exceeds allowance"). That is this
  // action over the gas cap, not the endpoint failing. Matched only, never printed.
  if (causes.some(e => e.name === 'RpcRequestError' && /gas required exceeds/.test(e.details))) return { class: 'retry', code: 'KEEPER_GAS_CAP' };
  const data = causes.at(-1)?.data, hex = typeof data === 'string' ? data : data?.data;
  if (typeof hex === 'string' && reverts[hex.slice(0, 10)]) return reverts[hex.slice(0, 10)];
  if (causes.some(e => e.name === 'ExecutionRevertedError')) return { class: 'retry', code: 'REVERT_UNKNOWN' };
  // Anything else viem raises is the provider (timeout, JSON-RPC error, bad response). The rest is a defect here: visible, never fatal.
  // A timeout is named as one however deeply a read wraps it (a Multicall3 read wraps it twice).
  const name = String((causes.find(e => e.name === 'TimeoutError') ?? error)?.name ?? 'Error').replace(/[^A-Za-z0-9]/g, '').slice(0, 40).toUpperCase();
  return causes.some(e => typeof e.walk === 'function') ? { class: 'retry', code: `RPC_${name}`, rpc: true } : { class: 'retry', code: `UNEXPECTED_${name}` };
}
