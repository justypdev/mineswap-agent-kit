/**
 * Router v1's swapExactInPath through the USDC/WETH ENTRY hop predicts its BG legs from the hop's
 * output at quote time and must match it to the wei, so it reverts (SumMismatch / TransferFailed)
 * whenever that pool moves before inclusion — about 17% of Base blocks. buy_bg therefore sizes from
 * such a quote and sends v1's UniV2 entry (swapExactTokensForTokens [USDC, WETH, BG]), which derives
 * its legs on chain. Every other entry-hop swapExactInPath is refused as STALE_PRONE_ROUTE.
 */
import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { ROUTER_V1_ABI } from '../src/abis.js';
import { DexClient, buyBg, swap } from '../src/dex.js';
import { HttpClient } from '../src/http.js';
import { ADDR, SELECTOR } from '../src/pins.js';
import { FakeChain, SELF, TENTH_BG, decodedApprovals, v1Entry, v1Swap, v2SwapIn, walletOn } from './helpers.js';

const QUOTED_IN = 1_054_185n; // what the live exact-out quote for 0.1 BG at 75 bps spent (2026-10-31)

function server(data = v1Swap({ amountIn: QUOTED_IN }), extra: Record<string, unknown> = {}) {
  const body = { ok: true, executable: true, amountIn: QUOTED_IN.toString(), amountOut: '100756930012848515', amountOutMin: '100001253037752152', calldata: { to: ADDR.routerV1, data, value: '0' }, ...extra };
  return new DexClient(new HttpClient({ fetch: async () => new Response(JSON.stringify(body), { status: 200 }) }));
}

function funded(simOut: bigint) {
  const chain = new FakeChain();
  chain.setBal(ADDR.usdc, 5_000_000n);
  chain.swapOut = () => simOut; // what the router pays at the latest block, whatever floor is asked
  return chain;
}

const sentSwap = (chain: FakeChain) => {
  const tx = chain.sent.find((t) => t.to === ADDR.routerV1)!;
  const { functionName, args } = decodeFunctionData({ abi: ROUTER_V1_ABI, data: tx.data }) as { functionName: string; args: readonly unknown[] };
  return { tx, functionName, args };
};

describe('buy_bg on a stale-prone v1 entry-hop quote', () => {
  it('sends v1 swapExactTokensForTokens [USDC, WETH, BG] it builds itself, sized from the quote, paid to this wallet', async () => {
    const chain = funded(100_700_000_000_000_000n);
    const r = await buyBg(server(), walletOn(chain), { bgAmount: '0.1' });
    expect(r.dispatch).toBe('kit-built-v1-entry');
    expect(r.fn).toBe('swapExactTokensForTokens');
    const { tx, functionName, args } = sentSwap(chain);
    expect(tx.data.slice(0, 10)).toBe(SELECTOR.v1SwapExactTokensForTokens);
    expect(tx.value).toBe(0n);
    expect(functionName).toBe('swapExactTokensForTokens');
    expect(args[0]).toBe(QUOTED_IN);
    expect(args[2]).toEqual([ADDR.usdc, ADDR.weth, ADDR.bg]);
    expect(args[3]).toBe(SELF);
    expect(args[1] as bigint).toBeGreaterThanOrEqual(TENTH_BG);
    expect(decodedApprovals(chain)).toEqual([{ token: ADDR.usdc, spender: ADDR.routerV1, amount: QUOTED_IN }]);
    expect(chain.bal(ADDR.bg)).toBeGreaterThanOrEqual(TENTH_BG);
    expect(chain.sent.some((t) => t.data.startsWith(SELECTOR.v1SwapExactInPath))).toBe(false);
  });

  it('raises its own floor to 75 bps under the simulation when the hop moved in our favour, never lowers it', async () => {
    const sim = 102_000_000_000_000_000n; // the pool moved: the input now buys 2% more BG
    const chain = funded(sim);
    const r = await buyBg(server(), walletOn(chain), { bgAmount: '0.1' });
    const floor = (sim * 9_925n) / 10_000n;
    expect(r.tightened).toBe(true);
    expect(r.minOut).toBe(floor);
    expect(sentSwap(chain).args[1]).toBe(floor);
    // An untightened 0.1 floor would sit 196 bps under this simulation: over the 100 bps cap.
  });

  it('keeps the requested floor when the simulation is close to it', async () => {
    const chain = funded(100_300_000_000_000_000n);
    const r = await buyBg(server(), walletOn(chain), { bgAmount: '0.1' });
    expect(r.tightened).toBe(false);
    expect(sentSwap(chain).args[1]).toBe(TENTH_BG);
  });

  it('refuses when the hop moved against us (the input no longer buys 0.1 BG), and revokes the approval', async () => {
    const chain = funded(99_000_000_000_000_000n);
    await expect(buyBg(server(), walletOn(chain), { bgAmount: '0.1' })).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
    expect(chain.sent.filter((t) => t.to === ADDR.routerV1)).toHaveLength(0);
    expect(chain.allowance(ADDR.usdc, ADDR.routerV1)).toBe(0n);
  });

  it('honours maxUsdc against the quote\'s input', async () => {
    const chain = funded(100_700_000_000_000_000n);
    await expect(buyBg(server(), walletOn(chain), { bgAmount: '0.1', maxUsdc: '1' })).rejects.toMatchObject({ code: 'SPEND_LIMIT_EXCEEDED' });
    expect(chain.sent).toHaveLength(0);
  });

  it('after the org fix: a quote that already IS the UniV2 entry is checked and sent as quoted', async () => {
    const chain = funded(100_700_000_000_000_000n);
    const data = v1Entry({ amountIn: QUOTED_IN, minOut: 100_001_253_037_752_152n });
    const r = await buyBg(server(data), walletOn(chain), { bgAmount: '0.1' });
    expect(r.dispatch).toBe('quote-calldata');
    expect(r.tightened).toBe(false);
    expect(sentSwap(chain).tx.data).toBe(data);
  });
});

describe('every other entry-hop swapExactInPath is refused', () => {
  it('swap (exact input) refuses it as STALE_PRONE_ROUTE and signs nothing', async () => {
    const chain = funded(100_700_000_000_000_000n);
    await expect(swap(server(v1Swap({ amountIn: 1_000_000n })), walletOn(chain), { tokenIn: 'USDC', tokenOut: 'BG', amountIn: '1' }))
      .rejects.toMatchObject({ code: 'STALE_PRONE_ROUTE', reason: expect.stringMatching(/re-quote/) });
    expect(chain.sent).toHaveLength(0);
  });

  it('a router-v2 route is not affected', async () => {
    const chain = funded(100_700_000_000_000_000n);
    const r = await buyBg(server(v2SwapIn({ amountIn: QUOTED_IN }), { router: 'v2', calldata: { to: ADDR.routerV2, data: v2SwapIn({ amountIn: QUOTED_IN }), value: '0' } }), walletOn(chain), { bgAmount: '0.1' });
    expect(r.router).toBe('v2');
    expect(r.dispatch).toBe('quote-calldata');
  });
});
