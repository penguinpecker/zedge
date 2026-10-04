import { createHash, createHmac } from 'node:crypto';
import { decodeAbiParameters, encodeAbiParameters, keccak256 } from 'viem';

// Credentials never enter query strings, logging, errors, or redirects.
export const STREAMS_ORIGIN = 'https://api.dataengine.chain.link';
const envelope = [{ type: 'bytes32[3]' }, { type: 'bytes' }, { type: 'bytes32[]' }, { type: 'bytes32[]' }, { type: 'bytes32' }];
const bodyTypes = ['bytes32', 'uint32', 'uint32', 'uint192', 'uint192', 'uint32', 'int192', 'int192', 'int192'].map(type => ({ type }));
export function requireCondition(condition, code) { if (!condition) throw new Error(code); }
export function authentication(path, username, secret, timestamp = Date.now()) {
  requireCondition(/^\/api\/v1\/reports(?:\/latest)?\?feedID=0x[0-9a-f]{64}(?:&timestamp=[0-9]+)?$/.test(path), 'STREAMS_PATH');
  requireCondition(typeof username === 'string' && /^[A-Za-z0-9-]{1,160}$/.test(username), 'STREAMS_USERNAME');
  requireCondition(typeof secret === 'string' && secret.length >= 16 && secret.length <= 1024, 'STREAMS_SECRET');
  requireCondition(Number.isSafeInteger(timestamp) && timestamp > 0, 'STREAMS_CLOCK');
  const time = String(timestamp);
  const emptyHash = createHash('sha256').update('').digest('hex');
  const digest = createHmac('sha256', secret).update(`GET ${path} ${emptyHash} ${username} ${time}`).digest('hex');
  return { Authorization: username, 'X-Authorization-Timestamp': time, 'X-Authorization-Signature-SHA256': digest };
}

// Structural checks do not authenticate a report. Every publication still calls the real DON verifier.
export function decodeReport(payload, feedId) {
  requireCondition(typeof payload === 'string' && /^0x(?:[0-9a-fA-F]{2}){1,16384}$/.test(payload), 'STREAMS_PAYLOAD');
  const fields = decodeAbiParameters(envelope, payload);
  requireCondition(encodeAbiParameters(envelope, fields).toLowerCase() === payload.toLowerCase(), 'STREAMS_NONCANONICAL');
  const body = fields[1];
  requireCondition(body.length === 2 + 288 * 2 && fields[2].length === fields[3].length && fields[2].length > 0 && fields[2].length <= 32, 'STREAMS_SCHEMA');
  const [feed, validFrom, observed, , , expires, price] = decodeAbiParameters(bodyTypes, body);
  requireCondition(feed.toLowerCase() === feedId.toLowerCase() && feed.startsWith('0x0003'), 'STREAMS_FEED');
  requireCondition(price > 0n && validFrom <= observed && expires >= observed, 'STREAMS_OBSERVATION');
  return { price, validFromTimestamp: validFrom, observationsTimestamp: observed, expiresAt: expires, reportHash: keccak256(body), decimals: 18 };
}

export function validateBoundary(observation, boundary, sourceTime, window = 60) {
  requireCondition(Number.isSafeInteger(boundary) && boundary > 0 && boundary <= 0xffffffff, 'STREAMS_BOUNDARY');
  requireCondition(Number.isSafeInteger(window) && window >= 0 && window <= 60, 'STREAMS_WINDOW');
  requireCondition(observation.validFromTimestamp <= boundary && boundary <= observation.observationsTimestamp
    && observation.observationsTimestamp <= boundary + window && observation.observationsTimestamp <= sourceTime
    && sourceTime <= observation.expiresAt, 'STREAMS_BOUNDARY_WINDOW');
}

async function boundedJSON(response) {
  requireCondition(response.body && Number(response.headers.get('content-length') ?? 0) <= 131072, 'STREAMS_RESPONSE_SIZE');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      size += item.value.length; requireCondition(size <= 131072, 'STREAMS_RESPONSE_SIZE'); chunks.push(Buffer.from(item.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export class StreamsClient {
  #username; #secret; #fetch; #clock;
  constructor({ username, secret, fetchImpl = fetch, clock = Date.now }) {
    this.#username = username; this.#secret = secret; this.#fetch = fetchImpl; this.#clock = clock;
    authentication(`/api/v1/reports/latest?feedID=0x${'0'.repeat(64)}`, username, secret, clock());
  }
  async report(feedId, boundary) {
    requireCondition(/^0x0003[0-9a-f]{60}$/.test(feedId), 'STREAMS_FEED');
    requireCondition(boundary === undefined || Number.isSafeInteger(boundary) && boundary > 0 && boundary <= 0xffffffff, 'STREAMS_BOUNDARY');
    const path = boundary === undefined ? `/api/v1/reports/latest?feedID=${feedId}` : `/api/v1/reports?feedID=${feedId}&timestamp=${boundary}`;
    let response;
    try {
      response = await this.#fetch(`${STREAMS_ORIGIN}${path}`, { method: 'GET', headers: authentication(path, this.#username, this.#secret, this.#clock()),
        redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    } catch { throw new Error('STREAMS_TRANSPORT'); }
    // Do not forward provider bodies/errors, which may echo authentication headers.
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); throw new Error(`STREAMS_HTTP_${response.status}`); }
    let data;
    try { data = await boundedJSON(response); } catch { throw new Error('STREAMS_RESPONSE'); }
    const report = data?.report;
    requireCondition(report && typeof report.feedID === 'string' && report.feedID.toLowerCase() === feedId, 'STREAMS_RESPONSE_FEED');
    let observation;
    try { observation = decodeReport(report.fullReport, feedId); } catch { throw new Error('STREAMS_REPORT_INVALID'); }
    requireCondition(String(report.validFromTimestamp) === String(observation.validFromTimestamp)
      && String(report.observationsTimestamp) === String(observation.observationsTimestamp), 'STREAMS_RESPONSE_TIMESTAMPS');
    return { payload: report.fullReport, observation };
  }
}
