import { describe, expect, it } from 'vitest';
import { ALREADY_HAS_MINE_REASON } from '../src/guard/refusal.js';
import { ADDR, MINE_BURN_AMOUNT } from '../src/pins.js';
import { FakeChain, SELF, TENTH_BG, decodedApprovals, v1Entry, v2SwapIn, v2SwapOut, walletOn } from './helpers.js';

const want = { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, minOutFloor: TENTH_BG };

function funded() {
  const chain = new FakeChain();
  chain.setBal(ADDR.usdc, 10_000_000n);
  return chain;
}

describe('approvals are exact, to the router the swap targets, and never left behind', () => {
  it('v1: approves exactly amountIn to the v1 router; the router pulls it all, so nothing is revoked', async () => {
    const chain = funded();
    const w = walletOn(chain);
    const r = await w.executeSwap(await w.prepareSwap({ to: ADDR.routerV1, data: v1Entry({ amountIn: 1_060_000n }), value: 0n }, want));
    expect(decodedApprovals(chain)).toEqual([{ token: ADDR.usdc, spender: ADDR.routerV1, amount: 1_060_000n }]);
    expect(r.revokeHash).toBeNull();
    expect(chain.allowance(ADDR.usdc, ADDR.routerV1)).toBe(0n);
    expect(r.router).toBe('v1');
    expect(r.receivedOut).toBeGreaterThanOrEqual(TENTH_BG);
  });

  it('v2 exact-in: approves exactly plan.amountIn to router v2', async () => {
    const chain = funded();
    const w = walletOn(chain);
    await w.executeSwap(await w.prepareSwap({ to: ADDR.routerV2, data: v2SwapIn({ amountIn: 1_060_000n }), value: 0n }, want));
    expect(decodedApprovals(chain)).toEqual([{ token: ADDR.usdc, spender: ADDR.routerV2, amount: 1_060_000n }]);
  });

  it('v2 exact-out: approves maxIn, and revokes the unspent residue afterwards', async () => {
    const chain = funded();
    const w = walletOn(chain);
    const r = await w.executeSwap(await w.prepareSwap({ to: ADDR.routerV2, data: v2SwapOut({ amountIn: 1_050_000n, maxIn: 1_070_000n }), value: 0n }, want));
    expect(decodedApprovals(chain)).toEqual([
      { token: ADDR.usdc, spender: ADDR.routerV2, amount: 1_070_000n },
      { token: ADDR.usdc, spender: ADDR.routerV2, amount: 0n },
    ]);
    expect(r.revokeHash).not.toBeNull();
    expect(chain.allowance(ADDR.usdc, ADDR.routerV2)).toBe(0n);
  });

  it('a stale allowance of another size is overwritten with the exact amount, not topped up', async () => {
    const chain = funded();
    chain.allowances.set(chain.key(ADDR.usdc, ADDR.routerV1), 123n);
    const w = walletOn(chain);
    await w.executeSwap(await w.prepareSwap({ to: ADDR.routerV1, data: v1Entry({ amountIn: 1_060_000n }), value: 0n }, want));
    expect(decodedApprovals(chain)[0]).toEqual({ token: ADDR.usdc, spender: ADDR.routerV1, amount: 1_060_000n });
  });

  it('a slippage refusal AFTER the approval revokes it before returning the refusal; the swap is never sent', async () => {
    const chain = funded();
    chain.swapOut = (i) => i.minOut * 2n; // floor sits 50% under what the router would pay: a sandwich invitation
    const w = walletOn(chain);
    const p = await w.prepareSwap({ to: ADDR.routerV1, data: v1Entry({ amountIn: 1_060_000n }), value: 0n }, want);
    await expect(w.executeSwap(p)).rejects.toMatchObject({ code: 'SLIPPAGE_TOO_HIGH' });
    expect(decodedApprovals(chain).map((a) => a.amount)).toEqual([1_060_000n, 0n]);
    expect(chain.sent.filter((t) => t.to === ADDR.routerV1)).toHaveLength(0);
    expect(chain.allowance(ADDR.usdc, ADDR.routerV1)).toBe(0n);
  });

  it('a reverting simulation revokes the approval too', async () => {
    const chain = funded();
    const w = walletOn(chain);
    const p = await w.prepareSwap({ to: ADDR.routerV1, data: v1Entry(), value: 0n }, want);
    chain.failSimulation = true;
    await expect(w.executeSwap(p)).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
    expect(chain.allowance(ADDR.usdc, ADDR.routerV1)).toBe(0n);
  });

  it('insufficient balance is refused before any approval', async () => {
    const chain = new FakeChain();
    chain.setBal(ADDR.usdc, 1_000n);
    const w = walletOn(chain);
    await expect(w.prepareSwap({ to: ADDR.routerV1, data: v1Entry(), value: 0n }, want)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect(chain.sent).toHaveLength(0);
  });

  it('executeSwap only takes a swap prepared by this wallet, once', async () => {
    const chain = funded();
    const w = walletOn(chain);
    const forged = { intent: {} as never, tx: { to: ADDR.routerV1, data: v1Entry(), value: 0n }, want };
    await expect(w.executeSwap(forged)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    const p = await w.prepareSwap({ to: ADDR.routerV1, data: v1Entry(), value: 0n }, want);
    await w.executeSwap(p);
    await expect(w.executeSwap(p)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('activate_mine approvals', () => {
  it('approves exactly 0.1 BG to MineBurnEntry, then activates; the mine id is read on chain', async () => {
    const chain = new FakeChain();
    chain.setBal(ADDR.bg, TENTH_BG + 5n);
    const w = walletOn(chain);
    const r = await w.activateMine();
    expect(decodedApprovals(chain)).toEqual([{ token: ADDR.bg, spender: ADDR.mineBurnEntry, amount: MINE_BURN_AMOUNT }]);
    expect(chain.sent.at(-1)).toEqual({ to: ADDR.mineBurnEntry, data: '0x0f15f4c0', value: 0n });
    expect(r.mineId).toBe(68);
    expect(chain.allowance(ADDR.bg, ADDR.mineBurnEntry)).toBe(0n);
  });
  it('refuses when the wallet already has a mine, and when it holds under 0.1 BG — before any approval', async () => {
    const has = new FakeChain();
    has.setBal(ADDR.bg, TENTH_BG);
    has.mineId = 12n;
    await expect(walletOn(has).activateMine()).rejects.toMatchObject({ code: 'ALREADY_HAS_MINE' });
    const poor = new FakeChain();
    poor.setBal(ADDR.bg, TENTH_BG - 1n);
    await expect(walletOn(poor).activateMine()).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
    expect([...has.sent, ...poor.sent]).toHaveLength(0);
  });
  it('the one-Gold-Mine refusal is the kit\'s own fixed sentence: one per wallet, and the Clanker Mine on mineswap.app for another', async () => {
    const has = new FakeChain();
    has.setBal(ADDR.bg, TENTH_BG);
    has.mineId = 12n;
    const err = await walletOn(has).activateMine().catch((e) => e);
    expect(err).toMatchObject({ code: 'ALREADY_HAS_MINE', reason: ALREADY_HAS_MINE_REASON });
    expect(ALREADY_HAS_MINE_REASON).toBe(
      'This wallet already has its one Gold Mine (one per wallet). To add another mine, buy a Clanker Mine on mineswap.app; this kit does not buy Clanker Mines',
    );
    // fixed and bounded (review L-4): nothing read from the chain or a server is interpolated
    has.mineId = 9_999n;
    expect((await walletOn(has).activateMine().catch((e) => e)).reason).toBe(ALREADY_HAS_MINE_REASON);
    expect(ALREADY_HAS_MINE_REASON).not.toMatch(/\d|0x/);
    expect(ALREADY_HAS_MINE_REASON.length).toBeLessThan(200);
    // no investment language
    expect(ALREADY_HAS_MINE_REASON).not.toMatch(/yield|\bapr\b|\bapy\b|profit|\breturns?\b|guarantee|earn/i);
    expect(has.sent).toHaveLength(0);
  });
  it('the wallet address is the signer address, checksummed', () => {
    expect(walletOn(new FakeChain()).address).toBe(SELF);
  });
});
