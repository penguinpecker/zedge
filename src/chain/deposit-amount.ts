import type { Address } from "viem";
import { parseAtomicAmount } from "./networks.ts";
import { MIN_SEND } from "./vault.ts";

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

/** One USDC transfer to or from the account on Base, lowercase addresses, in atoms. */
export type Transfer = { from: string; to: string; value: bigint };
/** The automatic deposit, from the address's whole Base USDC history in chain order. USDC from the vault (payouts, refunds) is
 * held: it is never swept back in. USDC from anyone else is external. A deposit (to the vault) spends external first, then held;
 * a send (to anyone else) spends held first, then external. `atoms` is min(balance, external): 0n below the smallest deposit,
 * capped at the largest. Null when the history does not add up to `balance` (the transfer index is behind the chain, or ahead of
 * the balance read): read both again later. */
export function autoDeposit(history: Transfer[], account: string, vault: string, balance: bigint, limits: { minDeposit: string; maxDeposit: string }): { atoms: bigint; held: bigint } | null {
  let held = 0n, external = 0n;
  for (const t of history) {
    if (t.from === t.to) continue; // to itself: nothing moves
    if (t.to === account) { if (t.from === vault) held += t.value; else external += t.value; continue; }
    if (t.from !== account) continue;
    const deposit = t.to === vault, first = deposit ? external : held, a = t.value < first ? t.value : first;
    if (deposit) { external -= a; held -= t.value - a; } else { held -= a; external -= t.value - a; }
  }
  // held + external is the history's balance; when it matches the chain's, min(balance, external) is external itself.
  if (held < 0n || external < 0n || held + external !== balance) return null;
  const min = BigInt(limits.minDeposit), max = BigInt(limits.maxDeposit);
  return { atoms: external < min ? 0n : external > max ? max : external, held };
}

/** The send form: a Base address that is not zero, the vault or the sender's own (any letter case), and at least 0.10 USDC with at
 * most 6 decimals, up to the balance. */
export function sendForm(to: string, amount: string, balance: bigint | null, own: string, vault: string): { to: Address; atoms: bigint } | { error: string } {
  const address = to.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { error: "Enter a Base address: 0x and 40 letters or digits." };
  if (/^0x0{40}$/.test(address)) return { error: "That is the zero address." };
  if (address === vault) return { error: "That is the ZEDGE vault. Use Move back to trading instead." };
  if (address === own) return { error: "That is your own address." };
  let atoms: bigint;
  try { atoms = parseAtomicAmount(amount.trim(), 6); } catch { return { error: "Enter an amount like 2.5, with at most 6 decimals." }; }
  if (atoms < MIN_SEND) return { error: "Sends start at 0.10 USDC." };
  if (balance !== null && atoms > balance) return { error: "That is more than you have on Base." };
  return { to: address as Address, atoms };
}
