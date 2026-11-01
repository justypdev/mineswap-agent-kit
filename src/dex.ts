/**
 * mineswap.org GET /api/quote, and the two dex flows built on it (buy_bg, swap). The API is
 * described at https://mineswap.org/openapi.json:
 *   tokenIn, tokenOut   addresses; the zero address is native ETH; BG must be on exactly one side
 *   amountIn | amountOut base-unit integers, EXACTLY one of them (amountOut = solve for the input)
 *   slippageBps          optional, clamped by the server to its ceiling
 *   recipient            optional; with it the response carries signable `calldata`
 * Response (200): { ok: true, amountIn, amountOut, amountOutMin, calldata: { to, data, value },
 * executable, router?: 'v2', … }. Refusals: { ok: false, status, code, error }.
 *
 * NOTHING in the response is trusted. The kit reads `calldata` and decodes it with the pinned
 * router's own ABI; the figures the server reports are passed on only as validated numbers (the
 * server's claim), and a refusal only as its validated code with a sentence the kit wrote.
 */
import { getAddress, isAddress, isHex, parseUnits, type Address, type Hex } from 'viem';
import { decodeIntent, type Intent, type SwapIntent } from './guard/decode.js';
import { checkSwap, requestSlippageBps, type SwapExpectation } from './guard/policy.js';
import { refuse } from './guard/refusal.js';
import type { GuardedWallet, SwapResult } from './guard/wallet.js';
import { HttpClient } from './http.js';
import { ADDR, DEX_ORIGIN, TOKENS, sameAddress, type TokenInfo } from './pins.js';

export type TokenSymbol = TokenInfo['symbol'];

export function tokenBySymbol(sym: string): TokenInfo {
  const t = (TOKENS as Record<string, TokenInfo | undefined>)[sym.toUpperCase()];
  if (!t) return refuse('TOKEN_NOT_ALLOWED', `${JSON.stringify(String(sym).slice(0, 16))} is not on the token allowlist (USDC, BG, WETH, ETH)`);
  return t;
}

/** A decimal amount ("1.5") in a token's base units; refuses anything that is not a plain positive decimal. */
export function parseAmount(amount: string, token: TokenInfo): bigint {
  if (typeof amount !== 'string' || !/^\d{1,30}(\.\d{1,30})?$/.test(amount)) refuse('INVALID_ARGUMENT', `amount ${JSON.stringify(String(amount).slice(0, 40))} is not a plain decimal number`);
  const [, frac = ''] = amount.split('.');
  if (frac.length > token.decimals) refuse('INVALID_ARGUMENT', `${token.symbol} has ${token.decimals} decimals; "${amount}" has more`);
  const v = parseUnits(amount, token.decimals);
  if (v <= 0n) refuse('INVALID_ARGUMENT', 'the amount must be greater than zero');
  return v;
}

export interface QuoteRequest {
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn?: bigint;
  readonly amountOut?: bigint;
  readonly slippageBps: number;
  readonly recipient: Address;
}

/** The parts of a quote response the kit reads. Every field is the SERVER'S CLAIM. */
export interface QuoteClaim {
  readonly router: 'v1' | 'v2';
  readonly calldata: { readonly to: Address; readonly data: Hex; readonly value: bigint };
  readonly claimedAmountIn: string | null;
  readonly claimedAmountOut: string | null;
  readonly claimedAmountOutMin: string | null;
  readonly claimedPriceImpactPct: number | null;
  readonly blockNumber: number | null;
  readonly raw: unknown;
}

export { requestSlippageBps } from './guard/policy.js';

/** The refusal codes /api/quote documents, each with the KIT's sentence (the server's text is never relayed). */
const QUOTE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  bad_request: 'the request was malformed',
  paused: 'the router is paused',
  no_route: 'no route exists for this pair',
  over_cap: 'the order is over the router\'s per-order cap; ask for less',
  unreachable_target: 'the book cannot deliver that much output',
  too_small: 'the amount is too small to route',
  high_impact: 'the price impact is over the site\'s ceiling; ask for less',
  exact_out_unavailable: 'exact-output quotes are not available right now',
  upstream: 'the quote service is temporarily unavailable; retry shortly',
  no_fee_anchor: 'router v2 has no fee position for this route',
  exact_out_hooked_v4: 'exact-output is not available through a hooked V4 pool',
  simulation: 'the route reverts when simulated',
  needs_approval: 'the route needs an approval first',
  insufficient_balance: 'the wallet cannot cover the input',
  usdc_paused: 'USDC is paused for a party to this route',
  reference_mismatch: 'the route disagreed with the site\'s independent reference',
  unverified: 'this pair has no independent reference and is not offered',
  restricted_asset: 'one side of the pair is a restricted asset',
});

export class QuoteRefused extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string) {
    const known = Object.hasOwn(QUOTE_REFUSALS, code);
    super(`mineswap.org refused the quote (${known ? code : 'unknown'}): ${known ? QUOTE_REFUSALS[code] : `HTTP ${status}`}`);
    this.name = 'QuoteRefused';
    this.code = known ? code : 'unknown';
    this.status = status;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? v : null);

/** Shape-check a quote response. Inconsistent or malformed responses are refused, not repaired. */
export function parseQuoteResponse(status: number, body: unknown): QuoteClaim {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') refuse('UNTRUSTED_RESPONSE', `the quote API answered ${status} with no JSON body`);
  if (b!.ok !== true) throw new QuoteRefused(status, typeof b!.code === 'string' ? b!.code : 'unknown');
  const cd = b!.calldata as Record<string, unknown> | undefined;
  if (!cd || typeof cd.to !== 'string' || !isAddress(cd.to, { strict: false }) || typeof cd.data !== 'string' || !isHex(cd.data) || typeof cd.value !== 'string' || !/^\d{1,78}$/.test(cd.value)) {
    refuse('UNTRUSTED_RESPONSE', 'the quote response has no well-formed calldata');
  }
  if (b!.executable !== true || cd!.data === '0x') refuse('UNTRUSTED_RESPONSE', 'the quote is figures-only (not executable)');
  const to = getAddress(cd!.to as string);
  const routerField = b!.router;
  // Never echo the field: it is server text and would reach the agent.
  if (routerField !== undefined && routerField !== 'v2') refuse('UNTRUSTED_RESPONSE', 'the quote response names a router the kit does not know (only "v2", or no router field, is accepted)');
  // The API's own invariant: `router: 'v2'` ⇔ calldata.to is router v2; otherwise it is v1.
  if (routerField === 'v2' ? !sameAddress(to, ADDR.routerV2) : !sameAddress(to, ADDR.routerV1)) {
    refuse('TARGET_NOT_PINNED', `the quote says router ${routerField === 'v2' ? 'v2' : 'v1'} but its calldata targets ${to}`);
  }
  return {
    router: routerField === 'v2' ? 'v2' : 'v1',
    calldata: { to, data: cd!.data as Hex, value: BigInt(cd!.value as string) },
    claimedAmountIn: str(b!.amountIn),
    claimedAmountOut: str(b!.amountOut),
    claimedAmountOutMin: str(b!.amountOutMin),
    claimedPriceImpactPct: typeof b!.priceImpactPct === 'number' && Number.isFinite(b!.priceImpactPct) && Math.abs(b!.priceImpactPct) <= 100 ? b!.priceImpactPct : null,
    blockNumber: typeof b!.blockNumber === 'number' && Number.isSafeInteger(b!.blockNumber) ? b!.blockNumber : null,
    raw: body,
  };
}

export class DexClient {
  constructor(private readonly http: HttpClient, private readonly origin: string = DEX_ORIGIN) {}

  async quote(q: QuoteRequest): Promise<QuoteClaim> {
    if ((q.amountIn === undefined) === (q.amountOut === undefined)) refuse('INVALID_ARGUMENT', 'give exactly one of amountIn or amountOut');
    const u = new URL('/api/quote', this.origin);
    u.searchParams.set('tokenIn', q.tokenIn);
    u.searchParams.set('tokenOut', q.tokenOut);
    if (q.amountIn !== undefined) u.searchParams.set('amountIn', q.amountIn.toString());
    if (q.amountOut !== undefined) u.searchParams.set('amountOut', q.amountOut.toString());
    u.searchParams.set('slippageBps', String(q.slippageBps));
    u.searchParams.set('recipient', q.recipient);
    const { status, body } = await this.http.requestJson(u.toString(), { headers: { accept: 'application/json' } });
    return parseQuoteResponse(status, body);
  }
}

export interface DexFlowResult extends SwapResult {
  readonly quote: Omit<QuoteClaim, 'raw' | 'calldata'>;
  /**
   * `quote-calldata`: the quote's own calldata was checked and sent. `kit-built-v1-entry`: the quote
   * was a stale-prone v1 entry-hop swapExactInPath, so the kit sent v1 swapExactTokensForTokens it
   * built itself, sized from the quote's input.
   */
  readonly dispatch: 'quote-calldata' | 'kit-built-v1-entry';
}

/** True for a v1 swapExactInPath through an entry hop: legs predicted to the wei, stale when the hop moves. */
export function isStaleProneV1(intent: Intent): intent is SwapIntent {
  return intent.kind === 'swap' && intent.router === 'v1' && intent.fn === 'swapExactInPath' && intent.entryHops > 0;
}

const summarize = (c: QuoteClaim): Omit<QuoteClaim, 'raw' | 'calldata'> => {
  const { raw: _raw, calldata: _cd, ...rest } = c;
  return rest;
};

/** Read-only: quote, decode and statically check — what the kit WOULD sign, without signing. */
export async function previewSwap(dex: DexClient, wallet: GuardedWallet, req: QuoteRequest, want: SwapExpectation, nowSec: number) {
  const claim = await dex.quote(req);
  const intent = decodeIntent(claim.calldata);
  if (intent.kind !== 'swap') refuse('SELECTOR_NOT_ALLOWED', 'the quote calldata is not a swap');
  let verdict: { ok: true } | { ok: false; code: string; reason: string } = { ok: true };
  try {
    checkSwap(intent as SwapIntent, { self: wallet.address, nowSec, limits: wallet.limits }, want);
  } catch (e) {
    const r = e as { code?: string; reason?: string; message: string };
    verdict = { ok: false, code: r.code ?? 'ERROR', reason: r.reason ?? r.message };
  }
  const note = verdict.ok === false && verdict.code === 'STALE_PRONE_ROUTE' && sameAddress(req.tokenIn, ADDR.usdc) && sameAddress(req.tokenOut, ADDR.bg)
    ? 'buy_bg does not send this calldata: it sends v1 swapExactTokensForTokens [USDC, WETH, BG] that it builds itself, sized from this quote.'
    : null;
  return { quote: summarize(claim), decoded: intent as SwapIntent, staticCheck: verdict, ...(note ? { note } : {}) };
}

/** Buy exactly `bgAmount` BG (at least that much arrives) with USDC through a pinned router. */
export async function buyBg(dex: DexClient, wallet: GuardedWallet, p: { bgAmount: string; maxUsdc?: string }): Promise<DexFlowResult> {
  const amountOut = parseAmount(p.bgAmount, TOKENS.BG);
  const maxSpend = p.maxUsdc !== undefined ? parseAmount(p.maxUsdc, TOKENS.USDC) : undefined;
  const claim = await dex.quote({ tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountOut, slippageBps: requestSlippageBps(wallet.limits.maxSlippageBps), recipient: wallet.address });
  const want: SwapExpectation = { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, minOutFloor: amountOut, ...(maxSpend !== undefined ? { maxSpend } : {}) };
  const quoted = decodeIntent(claim.calldata);
  if (isStaleProneV1(quoted)) {
    // The live USDC→BG quote (v1 split router through the USDC/WETH entry hop) would revert
    // SumMismatch / TransferFailed whenever the hop pool moves before inclusion. Use only the
    // quote's INPUT size and send the router's UniV2 entry, which derives its legs on chain.
    // The quote is still held to every other rule (tokens, recipient = this wallet, value, floor,
    // deadline, size): a quote that fails them is a lying or broken server, and is not sized from.
    wallet.checkSwapStatic({ ...quoted, entryHops: 0 }, want);
    const prepared = await wallet.prepareV1EntrySwap({ tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountIn: quoted.spend, floor: amountOut, want });
    const result = await wallet.executeSwap(prepared);
    return { ...result, quote: summarize(claim), dispatch: 'kit-built-v1-entry' };
  }
  const prepared = await wallet.prepareSwap(claim.calldata, want);
  const result = await wallet.executeSwap(prepared);
  return { ...result, quote: summarize(claim), dispatch: 'quote-calldata' };
}

/** Exact-input swap between two allowlisted tokens (BG on exactly one side). */
export async function swap(dex: DexClient, wallet: GuardedWallet, p: { tokenIn: string; tokenOut: string; amountIn: string; minAmountOut?: string }): Promise<DexFlowResult> {
  const tIn = tokenBySymbol(p.tokenIn);
  const tOut = tokenBySymbol(p.tokenOut);
  const amountIn = parseAmount(p.amountIn, tIn);
  const minOutFloor = p.minAmountOut !== undefined ? parseAmount(p.minAmountOut, tOut) : undefined;
  const claim = await dex.quote({ tokenIn: tIn.address, tokenOut: tOut.address, amountIn, slippageBps: requestSlippageBps(wallet.limits.maxSlippageBps), recipient: wallet.address });
  const prepared = await wallet.prepareSwap(claim.calldata, {
    tokenIn: tIn.address, tokenOut: tOut.address, exactSpend: amountIn, ...(minOutFloor !== undefined ? { minOutFloor } : {}),
  });
  const result = await wallet.executeSwap(prepared);
  return { ...result, quote: summarize(claim), dispatch: 'quote-calldata' };
}
