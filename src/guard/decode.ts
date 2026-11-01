/**
 * Calldata → a typed intent, or a refusal that says why. Pure: no RPC, no clock.
 *
 * Order matters for the quality of the refusal, not for safety: a transfer, an NFT approval or a
 * permit is named as such wherever it is aimed; then the target must be pinned; then the
 * (target, selector) pair must be one of the five the kit signs. Router calldata is decoded with
 * that router's own ABI and must RE-ENCODE to the identical bytes, so trailing data or a
 * non-canonical encoding can never smuggle a second meaning past the decoder.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, isHex, maxUint256, type Address, type Hex } from 'viem';
import { ERC20_ABI, ROUTER_V1_ABI, ROUTER_V2_ABI } from '../abis.js';
import { ADDR, ETH_SENTINEL, NAMED_REFUSALS, SELECTOR, sameAddress, type RouterName } from '../pins.js';
import { refuse } from './refusal.js';

export interface TxRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly value: bigint;
}

export interface ApproveIntent {
  readonly kind: 'approve';
  readonly token: Address;
  readonly spender: Address;
  readonly amount: bigint;
}

export interface SwapIntent {
  readonly kind: 'swap';
  readonly router: RouterName;
  readonly routerAddress: Address;
  readonly fn: 'swapExactInPath' | 'swapExactTokensForTokens' | 'swapExactIn' | 'swapExactOut';
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  /** The most of `tokenIn` the call can pull from the wallet (exact-in: amountIn; exact-out: maxIn). */
  readonly spend: bigint;
  /** The least of `tokenOut` the recipient is guaranteed, as the router enforces it. */
  readonly minOut: bigint;
  readonly recipient: Address;
  readonly deadline: bigint;
  readonly value: bigint;
  /**
   * v1 swapExactInPath only: the number of ENTRY hop pools (`hopIn`). Its legs are predicted from
   * the hop's output at quote time and must match it to the wei on chain, so a non-zero value is
   * stale-prone (policy refuses it: STALE_PRONE_ROUTE). 0 for every other function.
   */
  readonly entryHops: number;
  /** v1 swapExactTokensForTokens only: the UniV2-style path (policy holds it to the canonical forms). */
  readonly path: readonly Address[] | null;
}

export interface ActivateIntent {
  readonly kind: 'activate';
}

export type Intent = ApproveIntent | SwapIntent | ActivateIntent;

const lower = (a: string) => a.toLowerCase();

function selectorOf(data: Hex): Hex {
  return lower(data.slice(0, 10)) as Hex;
}

function assertCanonical(original: Hex, reencoded: Hex): void {
  if (lower(original) !== lower(reencoded)) {
    refuse('MALFORMED_CALLDATA', 'the calldata does not re-encode to the same bytes (trailing or non-canonical data)');
  }
}

/** Decode one transaction into the intent it expresses. Throws GuardRefusal for anything else. */
export function decodeIntent(tx: TxRequest): Intent {
  if (!tx || typeof tx !== 'object') refuse('MALFORMED_CALLDATA', 'no transaction');
  if (typeof tx.to !== 'string' || !isAddress(tx.to, { strict: false })) refuse('MALFORMED_CALLDATA', 'the target is not an address');
  if (typeof tx.value !== 'bigint' || tx.value < 0n) refuse('MALFORMED_CALLDATA', 'the value is not a non-negative integer');
  const data = (tx.data ?? '0x') as Hex;
  if (!isHex(data, { strict: true })) refuse('MALFORMED_CALLDATA', 'the calldata is not hex');
  if (data.length === 2) {
    return tx.value > 0n
      ? refuse('PLAIN_VALUE_TRANSFER', `a plain ETH transfer to ${tx.to} is a transfer out of the wallet`)
      : refuse('MALFORMED_CALLDATA', 'empty calldata');
  }
  if (data.length < 10) refuse('MALFORMED_CALLDATA', 'the calldata is shorter than a selector');
  if ((data.length - 2) % 2 !== 0) refuse('MALFORMED_CALLDATA', 'the calldata has an odd number of hex digits');

  const sel = selectorOf(data);
  const to = getAddress(tx.to);

  const named = NAMED_REFUSALS[sel];
  if (named) {
    if (sel === '0xa22cb465') refuse('NFT_APPROVAL_REFUSED', `${named} would hand every token of ${to} to another operator`);
    if (sel === '0xd505accf') refuse('PERMIT_REFUSED', `${named} grants an allowance by signature; the kit never signs permits`);
    refuse('TRANSFER_REFUSED', `${named} on ${to} moves funds or NFTs out of the wallet`);
  }

  // The Mine NFT shares ERC-20's approve selector (ERC-721 approve(to, tokenId)).
  if (sameAddress(to, ADDR.goldMineNft)) {
    if (sel === SELECTOR.approve) refuse('NFT_APPROVAL_REFUSED', 'approve() on the Gold Mine NFT would let another address take the mine');
    refuse('SELECTOR_NOT_ALLOWED', `selector ${sel} on the Gold Mine NFT is not something the kit signs`);
  }

  if (sameAddress(to, ADDR.usdc) || sameAddress(to, ADDR.bg) || sameAddress(to, ADDR.weth)) {
    if (sel !== SELECTOR.approve) refuse('SELECTOR_NOT_ALLOWED', `selector ${sel} on token ${to} is not approve()`);
    if (tx.value !== 0n) refuse('VALUE_MISMATCH', 'an approve() call must carry no ETH');
    let args: readonly unknown[];
    try {
      ({ args } = decodeFunctionData({ abi: ERC20_ABI, data }) as { args: readonly unknown[] });
    } catch {
      return refuse('MALFORMED_CALLDATA', 'approve() calldata does not decode');
    }
    const [spender, amount] = args as [Address, bigint];
    assertCanonical(data, encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }));
    if (amount === maxUint256) refuse('UNLIMITED_APPROVAL', `approve(${spender}, MAX) is an unlimited approval`);
    return { kind: 'approve', token: to, spender: getAddress(spender), amount };
  }

  if (sameAddress(to, ADDR.mineBurnEntry)) {
    if (lower(data) !== SELECTOR.activate) {
      refuse(sel === SELECTOR.activate ? 'MALFORMED_CALLDATA' : 'SELECTOR_NOT_ALLOWED',
        sel === SELECTOR.activate ? 'activate() takes no arguments' : `selector ${sel} on MineBurnEntry is not activate()`);
    }
    if (tx.value !== 0n) refuse('VALUE_MISMATCH', 'activate() must carry no ETH');
    return { kind: 'activate' };
  }

  if (sameAddress(to, ADDR.routerV1)) {
    if (sel !== SELECTOR.v1SwapExactInPath && sel !== SELECTOR.v1SwapExactTokensForTokens) {
      refuse('SELECTOR_NOT_ALLOWED', `selector ${sel} on router v1 is not swapExactInPath or swapExactTokensForTokens`);
    }
    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: ROUTER_V1_ABI, data }) as { functionName: string; args: readonly unknown[] };
    } catch {
      return refuse('MALFORMED_CALLDATA', 'router v1 calldata does not decode');
    }
    const fn = decoded.functionName as 'swapExactInPath' | 'swapExactTokensForTokens';
    assertCanonical(data, encodeFunctionData({ abi: ROUTER_V1_ABI, functionName: fn, args: decoded.args as never }));
    if (fn === 'swapExactTokensForTokens') {
      const [amountIn, amountOutMin, path, recipient, deadline] = decoded.args as [bigint, bigint, readonly Address[], Address, bigint];
      if (path.length < 2) refuse('PATH_NOT_ALLOWED', 'the UniV2 entry path has fewer than two tokens');
      return {
        kind: 'swap', router: 'v1', routerAddress: ADDR.routerV1, fn,
        tokenIn: getAddress(path[0]!), tokenOut: getAddress(path[path.length - 1]!),
        spend: amountIn, minOut: amountOutMin, recipient: getAddress(recipient), deadline, value: tx.value,
        entryHops: 0, path: path.map((a) => getAddress(a)),
      };
    }
    const [tokenIn, tokenOut, amountIn, hopIn, , , minTotalOut, recipient, deadline] = decoded.args as [Address, Address, bigint, readonly Address[], unknown, unknown, bigint, Address, bigint];
    return {
      kind: 'swap', router: 'v1', routerAddress: ADDR.routerV1, fn,
      tokenIn: getAddress(tokenIn), tokenOut: getAddress(tokenOut),
      spend: amountIn, minOut: minTotalOut, recipient: getAddress(recipient), deadline, value: tx.value,
      entryHops: hopIn.length, path: null,
    };
  }

  if (sameAddress(to, ADDR.routerV2)) {
    if (sel !== SELECTOR.v2SwapExactIn && sel !== SELECTOR.v2SwapExactOut) {
      refuse('SELECTOR_NOT_ALLOWED', `selector ${sel} on router v2 is not swapExactIn or swapExactOut`);
    }
    let decoded: { functionName: string; args: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: ROUTER_V2_ABI, data }) as { functionName: string; args: readonly unknown[] };
    } catch {
      return refuse('MALFORMED_CALLDATA', 'router v2 calldata does not decode');
    }
    const fn = decoded.functionName as 'swapExactIn' | 'swapExactOut';
    assertCanonical(data, encodeFunctionData({ abi: ROUTER_V2_ABI, functionName: fn, args: decoded.args as never }));
    type Leg = { minOut: bigint };
    type Plan = { tokenIn: Address; tokenOut: Address; amountIn: bigint; hops: ReadonlyArray<{ legs: readonly Leg[] }> };
    const [plan, bound, recipient, deadline] = decoded.args as [Plan, bigint, Address, bigint];
    if (!plan.hops.length || plan.hops.some((h) => !h.legs.length)) refuse('MALFORMED_CALLDATA', 'router v2 plan has an empty hop');
    let spend: bigint;
    let minOut: bigint;
    if (fn === 'swapExactIn') {
      spend = plan.amountIn;
      minOut = bound;
    } else {
      // swapExactOut: `bound` is maxIn, and the final hop's leg floors are the only output guarantee.
      if (plan.amountIn > bound) refuse('MALFORMED_CALLDATA', 'router v2 exact-out plan spends more than its own maxIn');
      spend = sameAddress(plan.tokenIn, ETH_SENTINEL) ? plan.amountIn : bound;
      minOut = plan.hops[plan.hops.length - 1]!.legs.reduce((s, l) => s + l.minOut, 0n);
    }
    return {
      kind: 'swap', router: 'v2', routerAddress: ADDR.routerV2, fn,
      tokenIn: getAddress(plan.tokenIn), tokenOut: getAddress(plan.tokenOut),
      spend, minOut, recipient: getAddress(recipient), deadline, value: tx.value,
      entryHops: 0, path: null,
    };
  }

  return refuse('TARGET_NOT_PINNED', `${to} is not one of the pinned contracts`);
}
