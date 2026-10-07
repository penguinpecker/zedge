// Pure: raw eth_getLogs entries → this application's rows (schema.sql). No I/O. Hashes, addresses and data become Buffers (bytea).
import { decodeEventLog } from "viem";
import { endpointAbi } from "../../src/chain/orderbook-manifest.ts";
import { SUBTYPES } from "../../src/chain/vault.ts";

const KIND = new Map(Object.entries(SUBTYPES).map(([label, subtype]) => [subtype, label]));
export const bytes = (hex) => Buffer.from(hex.slice(2), "hex");
export const hex = (buffer) => `0x${buffer.toString("hex")}`;

/** `logs` as eth_getLogs returns them (removed ones already dropped); only the endpoint's events of application `app` (bigint) count. */
export function rows(logs, endpoint, app) {
  const out = { requests: [], completions: [], receipts: [], records: [] };
  for (const l of logs) {
    if (String(l.address).toLowerCase() !== endpoint) continue;
    let e;
    try { e = decodeEventLog({ abi: endpointAbi, topics: l.topics, data: l.data }); } catch { continue; } // another event, or malformed
    if (e.args.applicationId !== app) continue;
    const at = { block: Number(l.blockNumber), log_index: Number(l.logIndex), tx: bytes(l.transactionHash) }, id = bytes(e.args.requestId);
    if (e.eventName === "RequestSubmitted") out.requests.push({ request_id: id, sender: bytes(e.args.sender), ...at });
    // Postgres text holds no NUL; the string is public and display-only.
    else if (e.eventName === "RequestCompleted") out.completions.push({ request_id: id, ...at, status: e.args.status, error_code: e.args.errorCode, error_message: e.args.errorMessage.replaceAll("\0", "") });
    else if (e.eventName === "UserEvent") out.receipts.push({ ...at, request_id: id, data: bytes(e.args.encryptedData) });
    else if (e.eventName === "AppEvent") {
      const kind = KIND.get(e.args.eventSubType) ?? e.args.eventSubType, data = bytes(e.args.data);
      out.records.push({ ...at, request_id: id, kind, round_id: (kind === "settle" || kind === "confirm") && data.length >= 32 ? data.subarray(0, 32) : null, data });
    }
  }
  return out;
}
