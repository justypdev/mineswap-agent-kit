/**
 * Every row is a transaction a tricked or compromised agent — or a lying quote server — might put
 * in front of the signer. Each must be refused, and the refusal must say why (its code).
 */
import { readFileSync } from 'node:fs';
import { concat, encodeFunctionData, maxUint256, parseAbi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { parseQuoteResponse } from '../src/dex.js';
import type { TxRequest } from '../src/guard/decode.js';
import { DEFAULT_LIMITS } from '../src/guard/policy.js';
import { GuardRefusal, type RefusalCode } from '../src/guard/refusal.js';
import { authorizeTransaction, type TxBinding } from '../src/guard/wallet.js';
import { decodeIntent, type SwapIntent } from '../src/guard/decode.js';
import { ADDR, MINE_BURN_AMOUNT } from '../src/pins.js';
import { ATTACKER, HOP_POOL, NOW_SEC, SELF, TENTH_BG, approveData, v1Entry, v1Swap, v2SwapIn, v2SwapOut } from './helpers.js';

const ctx = { self: SELF, nowSec: NOW_SEC, limits: DEFAULT_LIMITS };
const want = { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, minOutFloor: TENTH_BG };
const erc = parseAbi([
  'function transfer(address,uint256)',
  'function transferFrom(address,address,uint256)',
  'function setApprovalForAll(address,bool)',
  'function safeTransferFrom(address,address,uint256)',
  'function safeTransferFrom(address,address,uint256,bytes)',
  'function permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  'function increaseAllowance(address,uint256)',
  'function swapExactIn(address,address,uint256,(address,uint256,uint160)[],uint256,address,uint256)',
  'function withdraw(uint256)',
  'function multicall(bytes[])',
]);

/** A swap binding as prepareSwap would produce it, from the honest calldata. */
const swapBinding = (data: Hex, to: Address = ADDR.routerV1, value = 0n): TxBinding => ({ kind: 'swap', intent: decodeIntent({ to, data, value }) as SwapIntent, want });

type Row = [name: string, tx: TxRequest, binding: TxBinding, code: RefusalCode];
const USDC_APPROVE_V1: TxBinding = { kind: 'approval', token: ADDR.usdc, spender: ADDR.routerV1, amount: 1_060_000n };

const rows: Row[] = [
  // ── transfers out, in every shape ──
  ['ERC-20 transfer of USDC to an attacker', { to: ADDR.usdc, data: encodeFunctionData({ abi: erc, functionName: 'transfer', args: [ATTACKER, 1n] }), value: 0n }, USDC_APPROVE_V1, 'TRANSFER_REFUSED'],
  ['ERC-20 transfer of BG to an attacker', { to: ADDR.bg, data: encodeFunctionData({ abi: erc, functionName: 'transfer', args: [ATTACKER, TENTH_BG] }), value: 0n }, USDC_APPROVE_V1, 'TRANSFER_REFUSED'],
  ['transferFrom out of the wallet', { to: ADDR.usdc, data: encodeFunctionData({ abi: erc, functionName: 'transferFrom', args: [SELF, ATTACKER, 1n] }), value: 0n }, USDC_APPROVE_V1, 'TRANSFER_REFUSED'],
  ['transfer aimed at an unpinned token', { to: ATTACKER, data: encodeFunctionData({ abi: erc, functionName: 'transfer', args: [ATTACKER, 1n] }), value: 0n }, USDC_APPROVE_V1, 'TRANSFER_REFUSED'],
  ['plain ETH send to an attacker', { to: ATTACKER, data: '0x', value: 10n ** 16n }, USDC_APPROVE_V1, 'PLAIN_VALUE_TRANSFER'],
  ['WETH withdraw (unwrap) call', { to: ADDR.weth, data: encodeFunctionData({ abi: erc, functionName: 'withdraw', args: [1n] }), value: 0n }, USDC_APPROVE_V1, 'TRANSFER_REFUSED'],
  // ── NFT ──
  ['setApprovalForAll on the Mine NFT', { to: ADDR.goldMineNft, data: encodeFunctionData({ abi: erc, functionName: 'setApprovalForAll', args: [ATTACKER, true] }), value: 0n }, USDC_APPROVE_V1, 'NFT_APPROVAL_REFUSED'],
  ['safeTransferFrom of the mine', { to: ADDR.goldMineNft, data: encodeFunctionData({ abi: erc, functionName: 'safeTransferFrom', args: [SELF, ATTACKER, 68n] }), value: 0n }, USDC_APPROVE_V1, 'TRANSFER_REFUSED'],
  ['safeTransferFrom(bytes) of the mine', { to: ADDR.goldMineNft, data: encodeFunctionData({ abi: erc, functionName: 'safeTransferFrom', args: [SELF, ATTACKER, 68n, '0x'] }), value: 0n }, USDC_APPROVE_V1, 'TRANSFER_REFUSED'],
  ['ERC-721 approve(attacker, mineId) on the Mine NFT', { to: ADDR.goldMineNft, data: approveData(ATTACKER, 68n), value: 0n }, USDC_APPROVE_V1, 'NFT_APPROVAL_REFUSED'],
  // ── permits and allowance games ──
  ['EIP-2612 permit call', { to: ADDR.usdc, data: encodeFunctionData({ abi: erc, functionName: 'permit', args: [SELF, ATTACKER, maxUint256, 1n, 27, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`] }), value: 0n }, USDC_APPROVE_V1, 'PERMIT_REFUSED'],
  ['increaseAllowance to the router', { to: ADDR.usdc, data: encodeFunctionData({ abi: erc, functionName: 'increaseAllowance', args: [ADDR.routerV1, 1n] }), value: 0n }, USDC_APPROVE_V1, 'TRANSFER_REFUSED'],
  ['unlimited USDC approval to the router', { to: ADDR.usdc, data: approveData(ADDR.routerV1, maxUint256), value: 0n }, USDC_APPROVE_V1, 'UNLIMITED_APPROVAL'],
  ['USDC approval to an attacker', { to: ADDR.usdc, data: approveData(ATTACKER, 1_060_000n), value: 0n }, USDC_APPROVE_V1, 'SPENDER_NOT_PINNED'],
  ['USDC approval to router v2 when the swap targets v1', { to: ADDR.usdc, data: approveData(ADDR.routerV2, 1_060_000n), value: 0n }, USDC_APPROVE_V1, 'SPENDER_NOT_PINNED'],
  ['USDC approval one wei above the swap input', { to: ADDR.usdc, data: approveData(ADDR.routerV1, 1_060_001n), value: 0n }, USDC_APPROVE_V1, 'APPROVAL_NOT_EXACT'],
  ['BG approval to MineBurnEntry above 0.1 BG', { to: ADDR.bg, data: approveData(ADDR.mineBurnEntry, MINE_BURN_AMOUNT * 2n), value: 0n }, { kind: 'approval', token: ADDR.bg, spender: ADDR.mineBurnEntry, amount: MINE_BURN_AMOUNT * 2n }, 'APPROVAL_NOT_EXACT'],
  ['BG approval when the swap spends USDC', { to: ADDR.bg, data: approveData(ADDR.routerV1, 1_060_000n), value: 0n }, USDC_APPROVE_V1, 'TOKEN_MISMATCH'],
  ['an approval with no swap behind it', { to: ADDR.usdc, data: approveData(ADDR.routerV1, 1_060_000n), value: 0n }, { kind: 'activate' }, 'SELECTOR_NOT_ALLOWED'],
  ['approve() carrying ETH', { to: ADDR.usdc, data: approveData(ADDR.routerV1, 1_060_000n), value: 1n }, USDC_APPROVE_V1, 'VALUE_MISMATCH'],
  // ── wrong targets / selectors ──
  ['swap calldata aimed at an unpinned router', { to: ATTACKER, data: v1Entry(), value: 0n }, swapBinding(v1Entry()), 'TARGET_NOT_PINNED'],
  ['v1 swapExactIn (not one of the two allowlisted v1 functions)', { to: ADDR.routerV1, data: encodeFunctionData({ abi: erc, functionName: 'swapExactIn', args: [ADDR.usdc, ADDR.bg, 1n, [], 1n, SELF, 1n] }), value: 0n }, swapBinding(v1Entry()), 'SELECTOR_NOT_ALLOWED'],
  ['v1 path calldata sent to router v2', { to: ADDR.routerV2, data: v1Swap(), value: 0n }, swapBinding(v1Swap()), 'SELECTOR_NOT_ALLOWED'],
  ['a multicall wrapper on router v2', { to: ADDR.routerV2, data: encodeFunctionData({ abi: erc, functionName: 'multicall', args: [[v2SwapIn()]] }), value: 0n }, swapBinding(v2SwapIn(), ADDR.routerV2), 'SELECTOR_NOT_ALLOWED'],
  ['MineBurnEntry with arguments appended to activate()', { to: ADDR.mineBurnEntry, data: concat(['0x0f15f4c0', `0x${'00'.repeat(32)}`]), value: 0n }, { kind: 'activate' }, 'MALFORMED_CALLDATA'],
  ['activate() carrying ETH', { to: ADDR.mineBurnEntry, data: '0x0f15f4c0', value: 1n }, { kind: 'activate' }, 'VALUE_MISMATCH'],
  ['trailing bytes after a v1 swap', { to: ADDR.routerV1, data: concat([v1Entry(), '0xdeadbeef']), value: 0n }, swapBinding(v1Entry()), 'MALFORMED_CALLDATA'],
  ['truncated v2 calldata', { to: ADDR.routerV2, data: v2SwapIn().slice(0, 200) as Hex, value: 0n }, swapBinding(v2SwapIn(), ADDR.routerV2), 'MALFORMED_CALLDATA'],
  ['three-byte calldata', { to: ADDR.routerV1, data: '0xa80b96', value: 0n }, swapBinding(v1Entry()), 'MALFORMED_CALLDATA'],
  // ── swaps that pay someone else or break the request ──
  ['v1 hop-free path swap (WETH→BG) paying an attacker', { to: ADDR.routerV1, data: v1Swap({ tokenIn: ADDR.weth, hopIn: [], to: ATTACKER }), value: 0n }, { kind: 'swap', intent: decodeIntent({ to: ADDR.routerV1, data: v1Swap({ tokenIn: ADDR.weth, hopIn: [], to: ATTACKER }), value: 0n }) as SwapIntent, want: { tokenIn: ADDR.weth, tokenOut: ADDR.bg } }, 'RECIPIENT_NOT_SELF'],
  ['v2 exact-in swap paying an attacker', { to: ADDR.routerV2, data: v2SwapIn({ recipient: ATTACKER }), value: 0n }, swapBinding(v2SwapIn({ recipient: ATTACKER }), ADDR.routerV2), 'RECIPIENT_NOT_SELF'],
  ['v2 exact-out swap paying an attacker', { to: ADDR.routerV2, data: v2SwapOut({ recipient: ATTACKER }), value: 0n }, swapBinding(v2SwapOut({ recipient: ATTACKER }), ADDR.routerV2), 'RECIPIENT_NOT_SELF'],
  ['v1 swap with no minimum output', { to: ADDR.routerV1, data: v1Entry({ minOut: 0n }), value: 0n }, swapBinding(v1Entry({ minOut: 0n })), 'MIN_OUT_MISSING'],
  ['v1 swap guaranteeing less BG than asked', { to: ADDR.routerV1, data: v1Entry({ minOut: TENTH_BG - 1n }), value: 0n }, swapBinding(v1Entry({ minOut: TENTH_BG - 1n })), 'MIN_OUT_TOO_LOW'],
  ['v2 exact-out whose final legs guarantee less than asked', { to: ADDR.routerV2, data: v2SwapOut({ legMinOut: TENTH_BG / 2n }), value: 0n }, swapBinding(v2SwapOut({ legMinOut: TENTH_BG / 2n }), ADDR.routerV2), 'MIN_OUT_TOO_LOW'],
  ['v1 swap of WETH when USDC was requested', { to: ADDR.routerV1, data: v1Entry({ path: [ADDR.weth, ADDR.bg] }), value: 0n }, swapBinding(v1Entry({ path: [ADDR.weth, ADDR.bg] })), 'TOKEN_MISMATCH'],
  ['v1 path swap into an unlisted token', { to: ADDR.routerV1, data: v1Swap({ tokenIn: ADDR.weth, hopIn: [], tokenOut: ATTACKER }), value: 0n }, swapBinding(v1Swap({ tokenIn: ADDR.weth, hopIn: [], tokenOut: ATTACKER })), 'TOKEN_NOT_ALLOWED'],
  ['v1 path swap WETH→USDC (no BG side)', { to: ADDR.routerV1, data: v1Swap({ tokenIn: ADDR.weth, hopIn: [], tokenOut: ADDR.usdc }), value: 0n }, swapBinding(v1Swap({ tokenIn: ADDR.weth, hopIn: [], tokenOut: ADDR.usdc })), 'PAIR_NOT_ALLOWED'],
  ['token swap carrying ETH value', { to: ADDR.routerV1, data: v1Entry(), value: 1n }, swapBinding(v1Entry(), ADDR.routerV1, 1n), 'VALUE_MISMATCH'],
  ['swap with an expired deadline', { to: ADDR.routerV1, data: v1Entry({ deadline: BigInt(NOW_SEC - 1) }), value: 0n }, swapBinding(v1Entry({ deadline: BigInt(NOW_SEC - 1) })), 'DEADLINE_INVALID'],
  ['swap with a deadline days away', { to: ADDR.routerV1, data: v1Entry({ deadline: BigInt(NOW_SEC + 5 * 86400) }), value: 0n }, swapBinding(v1Entry({ deadline: BigInt(NOW_SEC + 5 * 86400) })), 'DEADLINE_INVALID'],
  ['a swap that differs from the one that was checked', { to: ADDR.routerV1, data: v1Entry({ amountIn: 9_000_000n }), value: 0n }, swapBinding(v1Entry()), 'AMOUNT_MISMATCH'],
  ['a swap with no prepared binding', { to: ADDR.routerV1, data: v1Entry(), value: 0n }, USDC_APPROVE_V1, 'SELECTOR_NOT_ALLOWED'],
  // ── stale-prone v1 entry-hop routes ──
  ['v1 swapExactInPath through the USDC/WETH entry hop (the live USDC→BG shape)', { to: ADDR.routerV1, data: v1Swap(), value: 0n }, swapBinding(v1Swap()), 'STALE_PRONE_ROUTE'],
  ['v1 swapExactInPath through an entry hop, paying an attacker', { to: ADDR.routerV1, data: v1Swap({ to: ATTACKER }), value: 0n }, swapBinding(v1Swap({ to: ATTACKER })), 'STALE_PRONE_ROUTE'],
  ['v1 swapExactInPath with two entry hops', { to: ADDR.routerV1, data: v1Swap({ hopIn: [HOP_POOL, HOP_POOL] }), value: 0n }, swapBinding(v1Swap({ hopIn: [HOP_POOL, HOP_POOL] })), 'STALE_PRONE_ROUTE'],
  // ── v1 swapExactTokensForTokens (the UniV2 entry) ──
  ['UniV2 entry paying an attacker', { to: ADDR.routerV1, data: v1Entry({ to: ATTACKER }), value: 0n }, swapBinding(v1Entry({ to: ATTACKER })), 'RECIPIENT_NOT_SELF'],
  ['UniV2 entry with no amountOutMin', { to: ADDR.routerV1, data: v1Entry({ minOut: 0n }), value: 0n }, swapBinding(v1Entry({ minOut: 0n })), 'MIN_OUT_MISSING'],
  ['UniV2 entry with amountOutMin below the BG asked for', { to: ADDR.routerV1, data: v1Entry({ minOut: TENTH_BG / 2n }), value: 0n }, swapBinding(v1Entry({ minOut: TENTH_BG / 2n })), 'MIN_OUT_TOO_LOW'],
  ['UniV2 entry on the bare [USDC, BG] path', { to: ADDR.routerV1, data: v1Entry({ path: [ADDR.usdc, ADDR.bg] }), value: 0n }, swapBinding(v1Entry({ path: [ADDR.usdc, ADDR.bg] })), 'PATH_NOT_ALLOWED'],
  ['UniV2 entry through an unlisted middle token', { to: ADDR.routerV1, data: v1Entry({ path: [ADDR.usdc, ATTACKER, ADDR.bg] }), value: 0n }, swapBinding(v1Entry({ path: [ADDR.usdc, ATTACKER, ADDR.bg] })), 'PATH_NOT_ALLOWED'],
  ['UniV2 entry on a four-token path', { to: ADDR.routerV1, data: v1Entry({ path: [ADDR.usdc, ADDR.weth, ADDR.weth, ADDR.bg] }), value: 0n }, swapBinding(v1Entry({ path: [ADDR.usdc, ADDR.weth, ADDR.weth, ADDR.bg] })), 'PATH_NOT_ALLOWED'],
  ['UniV2 entry ending at an unlisted token', { to: ADDR.routerV1, data: v1Entry({ path: [ADDR.usdc, ADDR.weth, ATTACKER] }), value: 0n }, swapBinding(v1Entry({ path: [ADDR.usdc, ADDR.weth, ATTACKER] })), 'PATH_NOT_ALLOWED'],
  ['UniV2 entry with no BG side ([USDC, WETH])', { to: ADDR.routerV1, data: v1Entry({ path: [ADDR.usdc, ADDR.weth] }), value: 0n }, swapBinding(v1Entry({ path: [ADDR.usdc, ADDR.weth] })), 'PATH_NOT_ALLOWED'],
  ['UniV2 entry with a one-token path', { to: ADDR.routerV1, data: v1Entry({ path: [ADDR.usdc] }), value: 0n }, swapBinding(v1Entry()), 'PATH_NOT_ALLOWED'],
  ['UniV2 entry carrying ETH value', { to: ADDR.routerV1, data: v1Entry(), value: 5n }, swapBinding(v1Entry(), ADDR.routerV1, 5n), 'VALUE_MISMATCH'],
  ['UniV2 entry with a deadline days away', { to: ADDR.routerV1, data: v1Entry({ deadline: BigInt(NOW_SEC + 3 * 86400) }), value: 0n }, swapBinding(v1Entry({ deadline: BigInt(NOW_SEC + 3 * 86400) })), 'DEADLINE_INVALID'],
  ['UniV2 entry calldata sent to router v2', { to: ADDR.routerV2, data: v1Entry(), value: 0n }, swapBinding(v1Entry()), 'SELECTOR_NOT_ALLOWED'],
  ['USDC approval to router v2 for a v1 UniV2-entry swap (wrong spender)', { to: ADDR.usdc, data: approveData(ADDR.routerV2, 1_060_000n), value: 0n }, { kind: 'approval', token: ADDR.usdc, spender: ADDR.routerV1, amount: 1_060_000n }, 'SPENDER_NOT_PINNED'],
  ['USDC approval to MineBurnEntry for a v1 UniV2-entry swap', { to: ADDR.usdc, data: approveData(ADDR.mineBurnEntry, 1_060_000n), value: 0n }, { kind: 'approval', token: ADDR.usdc, spender: ADDR.routerV1, amount: 1_060_000n }, 'SPENDER_NOT_PINNED'],
  ['activate() outside activateMine', { to: ADDR.mineBurnEntry, data: '0x0f15f4c0', value: 0n }, USDC_APPROVE_V1, 'SELECTOR_NOT_ALLOWED'],
  ['an arbitrary call to an unpinned contract', { to: ATTACKER, data: '0x12345678', value: 0n }, USDC_APPROVE_V1, 'TARGET_NOT_PINNED'],
  ['a call to Chainlink (pinned for reads only)', { to: ADDR.chainlinkEthUsd, data: '0xfeaf968c', value: 0n }, USDC_APPROVE_V1, 'TARGET_NOT_PINNED'],
];

describe('hostile calldata is refused, with its reason', () => {
  it.each(rows)('%s → %s', (_name, tx, binding, code) => {
    let err: unknown;
    try {
      authorizeTransaction(tx, binding, ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(GuardRefusal);
    expect((err as GuardRefusal).code).toBe(code);
    expect((err as GuardRefusal).reason.length).toBeGreaterThan(10);
  });

  it('the table covers at least 40 hostile shapes', () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });

  it('the honest v1, v2 exact-in and v2 exact-out swaps pass the same gate', () => {
    for (const [to, data] of [[ADDR.routerV1, v1Entry()], [ADDR.routerV2, v2SwapIn()], [ADDR.routerV2, v2SwapOut()]] as const) {
      expect(authorizeTransaction({ to, data, value: 0n }, swapBinding(data, to), ctx).kind).toBe('swap');
    }
    // A hop-free v1 path swap (WETH in) is not stale-prone and passes.
    const wethPath = v1Swap({ tokenIn: ADDR.weth, hopIn: [] });
    expect(authorizeTransaction({ to: ADDR.routerV1, data: wethPath, value: 0n }, { kind: 'swap', intent: decodeIntent({ to: ADDR.routerV1, data: wethPath, value: 0n }) as SwapIntent, want: { tokenIn: ADDR.weth, tokenOut: ADDR.bg } }, ctx).kind).toBe('swap');
    // Every canonical UniV2-entry path passes for its own pair.
    for (const path of [[ADDR.weth, ADDR.bg], [ADDR.usdc, ADDR.weth, ADDR.bg], [ADDR.bg, ADDR.weth], [ADDR.bg, ADDR.weth, ADDR.usdc]]) {
      const data = v1Entry({ path, minOut: 1n });
      const intent = decodeIntent({ to: ADDR.routerV1, data, value: 0n }) as SwapIntent;
      expect(authorizeTransaction({ to: ADDR.routerV1, data, value: 0n }, { kind: 'swap', intent, want: { tokenIn: path[0]!, tokenOut: path[path.length - 1]! } }, ctx).kind).toBe('swap');
    }
    expect(authorizeTransaction({ to: ADDR.usdc, data: approveData(ADDR.routerV1, 1_060_000n), value: 0n }, USDC_APPROVE_V1, ctx).kind).toBe('approve');
    expect(authorizeTransaction({ to: ADDR.bg, data: approveData(ADDR.mineBurnEntry, MINE_BURN_AMOUNT), value: 0n }, { kind: 'approval', token: ADDR.bg, spender: ADDR.mineBurnEntry, amount: MINE_BURN_AMOUNT }, ctx).kind).toBe('approve');
    expect(authorizeTransaction({ to: ADDR.mineBurnEntry, data: '0x0f15f4c0', value: 0n }, { kind: 'activate' }, ctx).kind).toBe('activate');
  });
});

describe('a REAL live quote (mineswap.org, block 53,332,188) for another recipient', () => {
  const live = JSON.parse(readFileSync(new URL('./fixtures/live-quote-usdc-bg-v1-2026-10-31.json', import.meta.url), 'utf8'));

  it('parses as a v1 split-router quote and decodes with the v1 ABI', () => {
    const claim = parseQuoteResponse(200, live);
    expect(claim.router).toBe('v1');
    expect(claim.calldata.to).toBe(ADDR.routerV1);
    const intent = decodeIntent(claim.calldata);
    expect(intent).toMatchObject({ kind: 'swap', router: 'v1', fn: 'swapExactInPath', tokenIn: ADDR.usdc, tokenOut: ADDR.bg, spend: 1_000_000n });
  });

  it('is never signed: it goes through the USDC/WETH entry hop (stale-prone), and it pays 0x1111…1111, not us', () => {
    const claim = parseQuoteResponse(200, live);
    const intent = decodeIntent(claim.calldata) as SwapIntent;
    expect(intent.entryHops).toBe(1);
    expect(intent.recipient).toBe('0x1111111111111111111111111111111111111111');
    expect(() => authorizeTransaction(claim.calldata, { kind: 'swap', intent, want: { tokenIn: ADDR.usdc, tokenOut: ADDR.bg } }, { ...ctx, nowSec: 1793454923 - 60 }))
      .toThrowError(/STALE_PRONE_ROUTE/);
  });

  it('a lying server that relabels the v1 calldata as router v2 is refused before decoding', () => {
    expect(() => parseQuoteResponse(200, { ...live, router: 'v2' })).toThrowError(/TARGET_NOT_PINNED/);
    expect(() => parseQuoteResponse(200, { ...live, calldata: { ...live.calldata, to: ATTACKER } })).toThrowError(/TARGET_NOT_PINNED/);
    expect(() => parseQuoteResponse(200, { ...live, router: 'v3' })).toThrowError(/UNTRUSTED_RESPONSE/);
    expect(() => parseQuoteResponse(200, { ...live, executable: false })).toThrowError(/UNTRUSTED_RESPONSE/);
  });
});
