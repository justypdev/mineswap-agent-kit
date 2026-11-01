/**
 * The REFERENCE price: what router v1's own UniV2-compatible entry (swapExactTokensForTokens over
 * v1's owner-registered pools, its legs derived on chain) would pay for the same input, simulated
 * from this wallet at the latest block.
 *
 * It does not depend on anything the quote server returned: the kit builds the call itself, through
 * the pinned router, over the pinned registry (its hash is checked at startup). The simulation
 * needs no approval and no funds: an eth_call state override sets this wallet's balance and its
 * allowance to v1 in the input token's pinned storage slots (verified at startup to read back).
 *
 * Every swap's guaranteed output is held to it (minOut ≥ reference × (1 − maxSlippage)), and a BG
 * sell is valued in USD by it. When the reference cannot be computed (v1 paused, an order over v1's
 * per-order cap, a slot that no longer reads back) the swap is refused, never waved through.
 */
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, type Address, type Hex, type PublicClient } from 'viem';
import { ERC20_ABI, ROUTER_V1_ABI } from '../abis.js';
import { ADDR, ETH_SENTINEL, TOKEN_SLOTS, sameAddress } from '../pins.js';
import { v1EntryPath } from './policy.js';
import { refuse } from './refusal.js';

export function mappingSlot(key: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [key, slot]));
}

export function nestedMappingSlot(outer: Address, inner: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [inner, mappingSlot(outer, slot)]));
}

/** A state override giving `owner` exactly `amount` of `token` and an allowance of `amount` to `spender`. */
export function fundingOverride(token: Address, owner: Address, spender: Address, amount: bigint) {
  const slots = TOKEN_SLOTS[token.toLowerCase()];
  if (!slots) return refuse('PRICE_UNAVAILABLE', `no pinned storage slots for ${token}`);
  const value = numberToHex(amount, { size: 32 });
  return [{ address: token, stateDiff: [{ slot: mappingSlot(owner, slots.balance), value }, { slot: nestedMappingSlot(owner, spender, slots.allowance), value }] }];
}

/** Native ETH is referenced through WETH (the UniV2 entry takes no ETH). */
const asErc20 = (t: Address): Address => (sameAddress(t, ETH_SENTINEL) ? ADDR.weth : t);

/** Router v1 UniV2-entry output for `amountIn` of tokenIn → tokenOut, from `self`, at the latest block. */
export async function referenceOut(client: PublicClient, self: Address, tokenIn: Address, tokenOut: Address, amountIn: bigint, deadline: bigint): Promise<bigint> {
  const tin = asErc20(tokenIn);
  const tout = asErc20(tokenOut);
  const path = v1EntryPath(tin, tout);
  if (!path) return refuse('PRICE_UNAVAILABLE', `router v1 has no reference route for ${tin} → ${tout}`);
  if (amountIn <= 0n) return refuse('PRICE_UNAVAILABLE', 'nothing to price');
  const data = encodeFunctionData({ abi: ROUTER_V1_ABI, functionName: 'swapExactTokensForTokens', args: [amountIn, 1n, [...path], self, deadline] });
  let ret: Hex | undefined;
  try {
    ({ data: ret } = await client.call({ account: self, to: ADDR.routerV1, data, stateOverride: fundingOverride(tin, self, ADDR.routerV1, amountIn) }));
  } catch {
    return refuse('PRICE_UNAVAILABLE', 'the reference route (router v1 UniV2 entry) reverts for this size, so the swap cannot be priced; nothing was signed');
  }
  if (!ret || ret === '0x') return refuse('PRICE_UNAVAILABLE', 'the reference route returned nothing');
  const amounts = decodeFunctionResult({ abi: ROUTER_V1_ABI, functionName: 'swapExactTokensForTokens', data: ret }) as readonly bigint[];
  const out = amounts[amounts.length - 1] ?? 0n;
  if (out <= 0n) return refuse('PRICE_UNAVAILABLE', 'the reference route pays nothing for this size');
  return out;
}

/** Startup check: an override of each pinned slot must read back through balanceOf / allowance. */
export async function verifyTokenSlots(client: PublicClient, probe: Address): Promise<Array<{ name: string; ok: boolean; detail: string }>> {
  const out: Array<{ name: string; ok: boolean; detail: string }> = [];
  const amount = 0x1234567890abcdefn;
  for (const token of [ADDR.bg, ADDR.usdc, ADDR.weth]) {
    const stateOverride = fundingOverride(token, probe, ADDR.routerV1, amount);
    try {
      const [bal, allow] = await Promise.all([
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [probe], stateOverride } as never) as Promise<bigint>,
        client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [probe, ADDR.routerV1], stateOverride } as never) as Promise<bigint>,
      ]);
      out.push({ name: `slots:${token}`, ok: bal === amount && allow === amount, detail: `balance ${bal === amount ? 'ok' : 'MISMATCH'}, allowance ${allow === amount ? 'ok' : 'MISMATCH'}` });
    } catch {
      out.push({ name: `slots:${token}`, ok: false, detail: 'state-override read failed (the RPC must support eth_call state overrides)' });
    }
  }
  return out;
}
