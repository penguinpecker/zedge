/** EVALUATION ONLY. Pads a request body for the ZEDGE Vela guest so that the
 * envelope `session.encryptCommand` encrypts is exactly REQUEST_BYTES long.
 * The guest refuses a request of any other length (adapters/vela/guest/README.md
 * §4): the executor encrypts without padding, so the length on chain would
 * otherwise give away the kind of command and, for an order, its side.
 *
 *   session.encryptCommand(command.id, padBody(session, command.id, commandBody(command)))
 *   session.encryptCommand(syncRequestId(account), padBody(session, syncRequestId(account), syncBody()))
 */
import type { EvaluationSession, PrivateEnvelope } from "./session.ts";

export const REQUEST_BYTES = 2048;

/** The body with a final `pad` of zeros. Builds the envelope exactly as
 * session.ts does, so its length is measured, not estimated. Throws if the
 * request cannot fit, which no command the guest could accept does. */
export function padBody<T extends { type: string }>(session: EvaluationSession, requestId: string, body: T): T & { pad: string } {
  const envelope = (pad: string): PrivateEnvelope => ({ version: 1, domain: session.domain, account: session.account,
    epoch: session.epoch.id, requestId, kind: "command", body: { ...body, pad } });
  const short = REQUEST_BYTES - new TextEncoder().encode(JSON.stringify(envelope(""))).length;
  if (short < 0) throw new Error("Request does not fit the request size class.");
  return { ...body, pad: "0".repeat(short) };
}
