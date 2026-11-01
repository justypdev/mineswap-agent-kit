import { describe, expect, it } from 'vitest';
import { DexClient, QuoteRefused, buyBg, parseAmount, previewSwap, requestSlippageBps, swap } from '../src/dex.js';
import { HttpClient } from '../src/http.js';
import { ADDR, ETH_SENTINEL, TOKENS } from '../src/pins.js';
import { ATTACKER, FakeChain, NOW_SEC, SELF, TENTH_BG, decodedApprovals, v1Entry, v1Swap, v2SwapIn, walletOn } from './helpers.js';
import { encodeFunctionData } from 'viem';
import { ROUTER_V1_ABI } from '../src/abis.js';

function quoteServer(make: (u: URL) => unknown, status = 200) {
  const seen: URL[] = [];
  const fetch = async (url: string) => {
    const u = new URL(url);
    seen.push(u);
    return new Response(JSON.stringify(make(u)), { status, headers: { 'content-type': 'application/json' } });
  };
  return { dex: new DexClient(new HttpClient({ fetch })), seen };
}

const v1Body = (data = v1Swap()) => ({ ok: true, executable: true, amountIn: '1060000', amountOut: '100500000000000000', amountOutMin: '100000000000000000', calldata: { to: ADDR.routerV1, data, value: '0' } });
const v2Body = (data = v2SwapIn()) => ({ ...v1Body(), router: 'v2', calldata: { to: ADDR.routerV2, data, value: '0' } });

describe('quote requests', () => {
  it('buy_bg asks for an exact-output USDC→BG quote paid to this wallet, at 3/4 of the kit\'s slippage cap', async () => {
    const chain = new FakeChain();
    chain.setBal(ADDR.usdc, 5_000_000n);
    const { dex, seen } = quoteServer(() => v1Body());
    await buyBg(dex, walletOn(chain), { bgAmount: '0.1' });
    const q = seen[0]!;
    expect(q.origin + q.pathname).toBe('https://mineswap.org/api/quote');
    expect(Object.fromEntries(q.searchParams)).toEqual({ tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountOut: TENTH_BG.toString(), slippageBps: '75', recipient: SELF });
  });

  it('asks for three quarters of the cap, at least 1 bps', () => {
    expect([100, 300, 500, 1].map(requestSlippageBps)).toEqual([75, 225, 375, 1]);
  });

  it('a server refusal is reported with its code', async () => {
    const { dex } = quoteServer(() => ({ ok: false, status: 422, code: 'over_cap', error: 'Over the per-order cap' }), 422);
    await expect(dex.quote({ tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountIn: 1n, slippageBps: 100, recipient: SELF })).rejects.toBeInstanceOf(QuoteRefused);
  });

  it('amount parsing refuses exponents, negatives, hex and excess decimals', () => {
    expect(parseAmount('0.1', TOKENS.BG)).toBe(TENTH_BG);
    expect(parseAmount('1.06', TOKENS.USDC)).toBe(1_060_000n);
    for (const bad of ['1e18', '-1', '0x10', '0', '1.0000001', ' 1', '']) {
      expect(() => parseAmount(bad, TOKENS.USDC)).toThrow(/INVALID_ARGUMENT/);
    }
  });
});

describe('buy_bg end to end (mocked chain), through both pinned routers', () => {
  it.each([['v1', v1Body()], ['v2', v2Body()]] as const)('router %s: approve exact → simulate → swap; BG arrives', async (router, body) => {
    const chain = new FakeChain();
    chain.setBal(ADDR.usdc, 5_000_000n);
    const { dex } = quoteServer(() => body);
    const r = await buyBg(dex, walletOn(chain), { bgAmount: '0.1' });
    expect(r.router).toBe(router);
    expect(r.routerAddress).toBe(router === 'v1' ? ADDR.routerV1 : ADDR.routerV2);
    expect(r.minOut).toBe(TENTH_BG);
    expect(chain.bal(ADDR.bg)).toBeGreaterThanOrEqual(TENTH_BG);
    expect(r.spendUsd).toBe('$1.06');
  });

  it('a lying server is refused: wrong recipient, wrong token, too little BG, too much USDC', async () => {
    const cases: Array<[unknown, string, Record<string, string>?]> = [
      // The stale-prone entry-hop shape is sized from, never signed — but still held to every other rule.
      [v1Body(v1Swap({ to: ATTACKER })), 'RECIPIENT_NOT_SELF'],
      [v1Body(v1Swap({ tokenIn: ADDR.weth })), 'TOKEN_MISMATCH'],
      [v1Body(v1Swap({ minOut: TENTH_BG / 10n })), 'MIN_OUT_TOO_LOW'],
      [v1Body(v1Swap({ amountIn: 4_000_000n })), 'SPEND_LIMIT_EXCEEDED', { maxUsdc: '2' }],
      // The UniV2-entry shape (what the fixed /api/quote returns) is checked and signed as sent.
      [v1Body(v1Entry({ to: ATTACKER })), 'RECIPIENT_NOT_SELF'],
      [v1Body(v1Entry({ minOut: TENTH_BG - 1n })), 'MIN_OUT_TOO_LOW'],
      [v1Body(v1Entry({ path: [ADDR.usdc, ADDR.bg] })), 'PATH_NOT_ALLOWED'],
      [v2Body(v1Swap()), 'SELECTOR_NOT_ALLOWED'],
      [{ ...v1Body(), router: 'v2' }, 'TARGET_NOT_PINNED'],
    ];
    for (const [body, code, extra] of cases) {
      const chain = new FakeChain();
      chain.setBal(ADDR.usdc, 50_000_000n);
      const { dex } = quoteServer(() => body);
      await expect(buyBg(dex, walletOn(chain), { bgAmount: '0.1', ...(extra ?? {}) })).rejects.toThrow(new RegExp(code));
      expect(chain.sent).toHaveLength(0);
    }
  });
});

describe('swap and quote preview', () => {
  it('ETH→BG sends exactly the input as value and needs no approval; its USD value comes from Chainlink', async () => {
    const chain = new FakeChain();
    chain.setBal(ETH_SENTINEL, 10n ** 18n);
    const amountIn = 10n ** 15n; // 0.001 ETH ≈ $2.25
    // 0.001 ETH ≈ $2.25 ≈ 0.2112 BG at the reference; the floor sits within 1% of it.
    const data = encodeFunctionData({ abi: ROUTER_V1_ABI, functionName: 'swapExactInPath', args: [ETH_SENTINEL, ADDR.bg, amountIn, [], [], [], 210_000_000_000_000_000n, SELF, BigInt(NOW_SEC + 300)] });
    const { dex } = quoteServer(() => ({ ...v1Body(data), calldata: { to: ADDR.routerV1, data, value: amountIn.toString() } }));
    const r = await swap(dex, walletOn(chain), { tokenIn: 'ETH', tokenOut: 'BG', amountIn: '0.001' });
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]!.value).toBe(amountIn);
    expect(r.spendUsd).toBe('$2.25');
  });

  it('a stale ETH/USD price refuses an ETH spend (the cap cannot be checked)', async () => {
    const chain = new FakeChain();
    chain.setBal(ETH_SENTINEL, 10n ** 18n);
    chain.priceUpdatedAt = BigInt(NOW_SEC - 7200);
    const amountIn = 10n ** 15n;
    const data = encodeFunctionData({ abi: ROUTER_V1_ABI, functionName: 'swapExactInPath', args: [ETH_SENTINEL, ADDR.bg, amountIn, [], [], [], 210_000_000_000_000_000n, SELF, BigInt(NOW_SEC + 300)] });
    const { dex } = quoteServer(() => ({ ...v1Body(data), calldata: { to: ADDR.routerV1, data, value: amountIn.toString() } }));
    await expect(swap(dex, walletOn(chain), { tokenIn: 'ETH', tokenOut: 'BG', amountIn: '0.001' })).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  it('refuses a token outside the allowlist before asking the server', async () => {
    const { dex, seen } = quoteServer(() => v1Body());
    await expect(swap(dex, walletOn(new FakeChain()), { tokenIn: 'DEGEN', tokenOut: 'BG', amountIn: '1' })).rejects.toMatchObject({ code: 'TOKEN_NOT_ALLOWED' });
    expect(seen).toHaveLength(0);
  });

  it('preview decodes and statically checks without signing', async () => {
    const chain = new FakeChain();
    const { dex } = quoteServer(() => v1Body(v1Entry({ to: ATTACKER })));
    const p = await previewSwap(dex, walletOn(chain), { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountOut: TENTH_BG, slippageBps: 100, recipient: SELF }, { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, minOutFloor: TENTH_BG }, NOW_SEC);
    expect(p.decoded.router).toBe('v1');
    expect(p.staticCheck).toMatchObject({ ok: false, code: 'RECIPIENT_NOT_SELF' });
    const { dex: stale } = quoteServer(() => v1Body());
    const q = await previewSwap(stale, walletOn(chain), { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountOut: TENTH_BG, slippageBps: 100, recipient: SELF }, { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, minOutFloor: TENTH_BG }, NOW_SEC);
    expect(q.staticCheck).toMatchObject({ ok: false, code: 'STALE_PRONE_ROUTE' });
    expect(q.note).toMatch(/swapExactTokensForTokens/);
    expect(chain.sent).toHaveLength(0);
    expect(chain.signed).toHaveLength(0);
  });
});
