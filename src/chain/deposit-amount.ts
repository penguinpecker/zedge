import { parseAtomicAmount } from "./networks.ts";

/** The wallet popup's deposit amount, in USDC atoms (0n when it cannot be deposited). Untyped, it is all of the wallet's USDC up to
 * the largest deposit; a typed amount replaces it. Format and range errors are reported for a typed amount only. `short`: the wallet
 * holds less than the smallest deposit. */
export function depositAmount(typed: string, wallet: bigint | null, limits: { minDeposit: string; maxDeposit: string }): { atoms: bigint; error: "" | "format" | "range"; short: boolean } {
  const min = BigInt(limits.minDeposit), max = BigInt(limits.maxDeposit), short = wallet !== null && wallet < min;
  if (!typed) {
    const all = wallet === null ? 0n : wallet < max ? wallet : max;
    return { atoms: all < min ? 0n : all, error: "", short };
  }
  let atoms: bigint;
  try { atoms = parseAtomicAmount(typed, 6); } catch { return { atoms: 0n, error: "format", short }; }
  return atoms < min || atoms > max || (wallet !== null && atoms > wallet) ? { atoms: 0n, error: "range", short } : { atoms, error: "", short };
}
