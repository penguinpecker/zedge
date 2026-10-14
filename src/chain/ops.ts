/** Operator health the site can read for itself: the house market maker's and the private exchange's operator's gas on Horizen. A book
 * that goes quiet or private trading that stalls gets its specific cause ("out of gas") instead of a generic word. Display only; never throws. */
import { formatUnits, type Address } from "viem";
import { baseClient, gasBalance } from "./gateway.ts";

/** services/market-maker minEthWei: below this the house stops quoting. */
export const HOUSE_FLOOR_WEI = 200_000_000_000_000n;
/** A request completion burns ~270k gas at Horizen's ~1 mwei (~0.0000003 ETH); below 0.00001 the operator's next send is about to fail. */
export const OPERATOR_FLOOR_WEI = 10_000_000_000_000n;
/** The keeper publishes every Chainlink report on Base (BaseStreamsPublisher, ~7 µETH each, bounded at ~3x that worst case) and
 * creates, opens, resolves or voids rounds on Horizen (under 1 µETH each). It refuses a send its balance cannot cover, waits through
 * the opening deadline and voids the round instead (2026-10-11, round #432: 0.00002 ETH on Base). */
export const KEEPER_LOW_BASE_WEI = 50_000_000_000_000n, KEEPER_LOW_WEI = 100_000_000_000_000n;
/** The keeper's registry lane wallet. Pinned: the open/settle records in /v1/live are emitted in the operator's completion
 * transaction, so their sender is the operator, never the keeper. */
export const KEEPER: Address = "0xaa6ae3c5aa0c561d67f0247835d884bb5db191d7";
export type Ops = { houseEth: bigint | null; operatorEth: bigint | null; keeper: { address: Address; eth: bigint | null; baseEth: bigint | null } | null };

const eth = (wei: bigint, chain = "Horizen") => `${Number(formatUnits(wei, 18)).toLocaleString("en-US", { maximumFractionDigits: 5 })} ETH on ${chain}`;
const low = (wei: bigint | null | undefined, floor: bigint) => wei !== null && wei !== undefined && wei < floor ? wei : null;

export function opsNotices(ops: Ops | null, round: { outcome: number; opened: boolean } | null): { keeper: string | null; operator: string | null; house: string | null; voidCause: string | null } {
  // The low balances themselves (null when healthy or unread), so each notice can quote its figure.
  const keeperBaseLow = low(ops?.keeper?.baseEth, KEEPER_LOW_BASE_WEI), keeperLow = keeperBaseLow !== null ? null : low(ops?.keeper?.eth, KEEPER_LOW_WEI), operatorLow = low(ops?.operatorEth, OPERATOR_FLOOR_WEI), houseLow = low(ops?.houseEth, HOUSE_FLOOR_WEI);
  return {
    keeper: keeperBaseLow !== null ? `Settlement paused: the keeper wallet is out of gas (${eth(keeperBaseLow, "Base")}). Price reports cannot be published until it is topped up.`
      : keeperLow !== null ? `Settlement paused: the keeper wallet is out of gas (${eth(keeperLow)}). Rounds cannot open or settle until it is topped up.` : null,
    operator: operatorLow !== null ? `Private trading paused: the operator wallet is out of gas (${eth(operatorLow)}). Orders cannot be processed until it is topped up.` : null,
    house: houseLow !== null ? `The house is out of gas (${eth(houseLow)}) and is not quoting.` : null,
    // A past void cannot be tied to the balance at that time, so the keeper's state is added only while it is low right now.
    voidCause: round?.outcome === 3 ? `${round.opened ? "No closing price was delivered in time." : "No opening price was published before the deadline."}${keeperBaseLow !== null || keeperLow !== null ? " The keeper wallet is out of gas." : ""}` : null,
  };
}

/** House and operator addresses come from the book's manifest, the keeper's is KEEPER. Any failure leaves its field null. */
export async function readOps(houseAddress: Address, operatorAddress: Address): Promise<Ops> {
  const [houseEth, operatorEth, keeperEth, keeperBaseEth] = await Promise.all([gasBalance(26514, houseAddress).catch(() => null), gasBalance(26514, operatorAddress).catch(() => null),
    gasBalance(26514, KEEPER).catch(() => null), baseClient().getBalance({ address: KEEPER }).catch(() => null)]);
  return { houseEth, operatorEth, keeper: { address: KEEPER, eth: keeperEth, baseEth: keeperBaseEth } };
}
