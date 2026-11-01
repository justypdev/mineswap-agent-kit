/**
 * The pure policy checks: what a decoded intent must satisfy before anything is signed.
 *
 * None of these read the network. The values they compare against come from the kit itself (its
 * own wallet address, its own clock, its config and the request the TOOL CALL asked for), never
 * from the quote server: the server's response is decoded and then held to the request.
 */
import { getAddress, type Address } from 'viem';
import { ADDR, APPROVAL_SPENDERS, ETH_SENTINEL, MINE_BURN_AMOUNT, ROUTERS, TOKENS, sameAddress } from '../pins.js';
import type { ApproveIntent, SwapIntent } from './decode.js';
import { refuse } from './refusal.js';

export interface Limits {
  /** Largest accepted (expectedOut − minOut) / expectedOut, in bps, measured against the kit's own simulation. */
  readonly maxSlippageBps: number;
  /** Largest USD value one swap may spend, in cents. */
  readonly maxTxUsdCents: bigint;
  /** Largest USD value all swaps may spend in any rolling 24 hours, in cents. */
  readonly maxDailyUsdCents: bigint;
  /** How far in the future a swap deadline may sit. */
  readonly maxDeadlineSeconds: number;
  /** Largest gas limit the kit will sign for one transaction. */
  readonly maxGasPerTx: bigint;
  /** Largest maxFeePerGas (wei) the kit will sign. The RPC's fee estimate is held to it. */
  readonly maxFeePerGasWei: bigint;
}

/** Hard ceilings a config can never raise. */
export const HARD_MAX_SLIPPAGE_BPS = 500;
export const HARD_MAX_DEADLINE_SECONDS = 3600;

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxSlippageBps: 100,
  maxTxUsdCents: 500n,
  maxDailyUsdCents: 2_000n,
  maxDeadlineSeconds: 1800,
  // 2.5M: headroom over the v1 UniV2 entry swap (1,153,765 gas measured on a Base fork, 2026-10-31,
  // over the 29-pool registry) if the registry grows; at the 0.5 gwei fee cap that is ~0.00125 ETH.
  maxGasPerTx: 2_500_000n,
  maxFeePerGasWei: 500_000_000n, // 0.5 gwei; Base runs at ~0.005-0.05 gwei
});

/** What the TOOL CALL asked for. The decoded swap must match it. */
export interface SwapExpectation {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** The least output the caller will accept (buy_bg: the BG it asked for). */
  readonly minOutFloor?: bigint;
  /** The most input the caller will accept. */
  readonly maxSpend?: bigint;
  /** Exact-input requests: the input must be exactly this. */
  readonly exactSpend?: bigint;
}

const ALLOWED_TOKENS = Object.values(TOKENS).map((t) => t.address.toLowerCase());
const isBg = (a: Address) => sameAddress(a, ADDR.bg);

export function tokenSymbol(a: Address): string {
  const t = Object.values(TOKENS).find((x) => sameAddress(x.address, a));
  return t ? t.symbol : a;
}

/**
 * The slippage the kit ASKS for (from the quote server, and when it sets a floor itself): three
 * quarters of its own cap. The guard then holds the floor to its own on-chain simulation against
 * the FULL cap, so a quoter-vs-chain difference of up to a quarter of the cap is not refused.
 */
export function requestSlippageBps(maxSlippageBps: number): number {
  return Math.max(1, Math.floor((maxSlippageBps * 3) / 4));
}

/**
 * The only paths the kit sends to v1's UniV2-compatible entry (swapExactTokensForTokens), as
 * MineSwapSplitRouter._pathToHops accepts them: BG with WETH directly, or BG with USDC through WETH
 * (the registered USDC/WETH hop). The router also takes a bare [USDC, BG]; the kit does not.
 */
export function v1EntryPath(tokenIn: Address, tokenOut: Address): readonly Address[] | null {
  const { usdc, weth, bg } = ADDR;
  if (sameAddress(tokenOut, bg)) {
    if (sameAddress(tokenIn, weth)) return [weth, bg];
    if (sameAddress(tokenIn, usdc)) return [usdc, weth, bg];
  }
  if (sameAddress(tokenIn, bg)) {
    if (sameAddress(tokenOut, weth)) return [bg, weth];
    if (sameAddress(tokenOut, usdc)) return [bg, weth, usdc];
  }
  return null;
}

/** Static checks on a decoded swap: tokens, pair, recipient, value, floors, deadline, size. */
export function checkSwap(intent: SwapIntent, ctx: { self: Address; nowSec: number; limits: Limits }, want: SwapExpectation): void {
  if (!sameAddress(intent.routerAddress, ROUTERS[intent.router])) refuse('TARGET_NOT_PINNED', 'the swap is not addressed to a pinned router');
  if (intent.router === 'v2' && sameAddress(intent.tokenIn, ADDR.bg)) {
    refuse('ROUTE_NOT_ALLOWED', 'router v2 plans name their own pools, which the kit cannot check against a registry; BG is only ever sold through router v1');
  }
  if (intent.fn === 'swapExactInPath' && intent.entryHops > 0) {
    refuse('STALE_PRONE_ROUTE', 'router v1 swapExactInPath with an entry hop predicts its legs from the hop pool to the wei and reverts when that pool moves; re-quote (buy_bg sends v1 swapExactTokensForTokens instead)');
  }
  if (intent.fn === 'swapExactTokensForTokens') {
    const canonical = v1EntryPath(intent.tokenIn, intent.tokenOut);
    const path = intent.path ?? [];
    if (!canonical || path.length !== canonical.length || path.some((a, i) => !sameAddress(a, canonical[i]!))) {
      refuse('PATH_NOT_ALLOWED', `path [${path.join(', ')}] is not one of the UniV2-entry paths the kit sends ([WETH, BG], [USDC, WETH, BG], [BG, WETH], [BG, WETH, USDC])`);
    }
  }
  for (const t of [intent.tokenIn, intent.tokenOut]) {
    if (!ALLOWED_TOKENS.includes(t.toLowerCase())) refuse('TOKEN_NOT_ALLOWED', `${t} is not on the token allowlist (USDC, BG, WETH, ETH)`);
  }
  if (sameAddress(intent.tokenIn, intent.tokenOut)) refuse('PAIR_NOT_ALLOWED', 'tokenIn and tokenOut are the same');
  if (isBg(intent.tokenIn) === isBg(intent.tokenOut)) refuse('PAIR_NOT_ALLOWED', 'a swap must have BG on exactly one side');
  if (!sameAddress(intent.tokenIn, want.tokenIn) || !sameAddress(intent.tokenOut, want.tokenOut)) {
    refuse('TOKEN_MISMATCH', `the calldata swaps ${tokenSymbol(intent.tokenIn)}→${tokenSymbol(intent.tokenOut)}, but ${tokenSymbol(want.tokenIn)}→${tokenSymbol(want.tokenOut)} was requested`);
  }
  if (!sameAddress(intent.recipient, ctx.self)) refuse('RECIPIENT_NOT_SELF', `the swap pays ${intent.recipient}, not this wallet (${getAddress(ctx.self)})`);

  const nativeIn = sameAddress(intent.tokenIn, ETH_SENTINEL);
  if (nativeIn ? intent.value !== intent.spend : intent.value !== 0n) {
    refuse('VALUE_MISMATCH', nativeIn
      ? `an ETH-in swap must send exactly its input as value (${intent.spend}), not ${intent.value}`
      : `a token-in swap must send no ETH, but carries ${intent.value} wei`);
  }
  if (intent.spend <= 0n) refuse('AMOUNT_MISMATCH', 'the swap spends nothing');
  if (intent.minOut <= 0n) refuse('MIN_OUT_MISSING', 'the swap has no minimum output');
  if (want.minOutFloor !== undefined && intent.minOut < want.minOutFloor) {
    refuse('MIN_OUT_TOO_LOW', `the swap guarantees ${intent.minOut} but at least ${want.minOutFloor} was requested`);
  }
  if (want.exactSpend !== undefined && intent.spend !== want.exactSpend) {
    refuse('AMOUNT_MISMATCH', `the swap spends ${intent.spend} but exactly ${want.exactSpend} was requested`);
  }
  if (want.maxSpend !== undefined && intent.spend > want.maxSpend) {
    refuse('SPEND_LIMIT_EXCEEDED', `the swap would spend ${intent.spend}, above the ${want.maxSpend} the caller allowed`);
  }
  const deadline = Number(intent.deadline);
  if (!Number.isSafeInteger(deadline) || deadline <= ctx.nowSec || deadline > ctx.nowSec + ctx.limits.maxDeadlineSeconds) {
    refuse('DEADLINE_INVALID', `deadline ${intent.deadline} is not within the next ${ctx.limits.maxDeadlineSeconds} s`);
  }
}

/**
 * The slippage rule, against the kit's OWN simulation of the exact calldata at the latest block:
 * the router's floor may sit at most `maxSlippageBps` below what the router says it would deliver
 * right now, and the simulation must clear the floor.
 */
export function checkSlippage(minOut: bigint, simulatedOut: bigint, maxSlippageBps: number): void {
  if (simulatedOut < minOut) {
    refuse('SIMULATION_FAILED', `the swap would deliver ${simulatedOut} now, below its own floor ${minOut}; it would revert`);
  }
  if (minOut * 10_000n < simulatedOut * BigInt(10_000 - maxSlippageBps)) {
    const bps = Number(((simulatedOut - minOut) * 10_000n) / simulatedOut);
    refuse('SLIPPAGE_TOO_HIGH', `the floor sits ${bps} bps below the simulated output; the cap is ${maxSlippageBps} bps`);
  }
}

/**
 * The reference floor, on every swap: the guaranteed output may sit at most `maxSlippageBps` below
 * what router v1's own UniV2 entry would pay for the same input right now (guard/reference.ts). The
 * route's own simulation cannot vouch for itself: a hostile route through a pool that pays nothing
 * simulates "fine" against its own floor.
 */
export function checkReferenceFloor(minOut: bigint, referenceOut: bigint, maxSlippageBps: number): void {
  if (minOut * 10_000n < referenceOut * BigInt(10_000 - maxSlippageBps)) {
    const bps = referenceOut > 0n ? Number(((referenceOut - minOut) * 10_000n) / referenceOut) : 10_000;
    refuse('MIN_OUT_BELOW_REFERENCE', `the swap guarantees ${minOut}, ${bps} bps under the reference price (${referenceOut} through router v1's own route); the cap is ${maxSlippageBps} bps`);
  }
}

/** The approval rule: a pinned spender for that token, the exact amount the swap needs, never unlimited. */
export function checkApproval(intent: ApproveIntent, need: { spender: Address; amount: bigint }): void {
  const spenders = APPROVAL_SPENDERS[intent.token.toLowerCase()];
  if (!spenders) refuse('TOKEN_NOT_ALLOWED', `${intent.token} is not a token the kit approves`);
  if (!spenders!.some((s) => sameAddress(s, intent.spender))) refuse('SPENDER_NOT_PINNED', `${intent.spender} is not a pinned spender for ${tokenSymbol(intent.token)}`);
  if (!sameAddress(intent.spender, need.spender)) refuse('SPENDER_NOT_PINNED', `the approval names ${intent.spender}, but the call it funds targets ${need.spender}`);
  if (sameAddress(intent.spender, ADDR.mineBurnEntry) && intent.amount !== 0n && intent.amount !== MINE_BURN_AMOUNT) {
    refuse('APPROVAL_NOT_EXACT', `MineBurnEntry may only be approved for exactly 0.1 BG (${MINE_BURN_AMOUNT}), not ${intent.amount}`);
  }
  if (intent.amount !== need.amount) refuse('APPROVAL_NOT_EXACT', `approve(${intent.amount}) is not the exact ${need.amount} the call pulls`);
}

// ── USD cap math (integer cents; every rounding is UP, so the caps err toward spending less) ──

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** USDC base units (6 dp) → cents, rounded up. */
export function usdcToCents(amount: bigint): bigint {
  return ceilDiv(amount, 10_000n);
}

/** ETH/WETH wei → cents at a Chainlink answer with `decimals` (8 on Base), rounded up. */
export function weiToCents(wei: bigint, answer: bigint, decimals: number): bigint {
  // wei / 1e18 * answer / 10^decimals * 100
  return ceilDiv(wei * answer * 100n, 10n ** BigInt(18 + decimals));
}

export function centsToUsd(cents: bigint): string {
  const neg = cents < 0n;
  const c = neg ? -cents : cents;
  return `${neg ? '-' : ''}$${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
}

export function dollarsToCents(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) throw new Error('a USD limit must be a non-negative number');
  return BigInt(Math.round(usd * 100));
}

/** Per-transaction and per-day caps on one spend. */
export function checkCaps(spendCents: bigint, spentTodayCents: bigint, limits: Limits): void {
  if (spendCents > limits.maxTxUsdCents) {
    refuse('TX_CAP_EXCEEDED', `this swap spends about ${centsToUsd(spendCents)}, above the per-transaction cap of ${centsToUsd(limits.maxTxUsdCents)}`);
  }
  if (spentTodayCents + spendCents > limits.maxDailyUsdCents) {
    refuse('DAILY_CAP_EXCEEDED', `${centsToUsd(spentTodayCents)} spent in the last 24 hours + ${centsToUsd(spendCents)} exceeds the 24-hour cap of ${centsToUsd(limits.maxDailyUsdCents)}`);
  }
}
