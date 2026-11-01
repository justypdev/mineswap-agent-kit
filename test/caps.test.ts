import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { FileLedger, MemoryLedger, WINDOW_MS, breakStaleLock } from '../src/guard/ledger.js';
import { DEFAULT_LIMITS, centsToUsd, checkCaps, checkSlippage, dollarsToCents, usdcToCents, weiToCents } from '../src/guard/policy.js';
import { GuardRefusal } from '../src/guard/refusal.js';
import { ADDR } from '../src/pins.js';
import { FakeChain, NOW_MS, SELF, TENTH_BG, v1Entry, walletOn } from './helpers.js';

const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as GuardRefusal).code; } return 'PASSED'; };

describe('USD cap math (integer cents, rounding up)', () => {
  it('USDC base units → cents, rounded up', () => {
    expect(usdcToCents(1_000_000n)).toBe(100n);
    expect(usdcToCents(1_060_712n)).toBe(107n);
    expect(usdcToCents(1n)).toBe(1n);
    expect(usdcToCents(0n)).toBe(0n);
  });
  it('wei → cents at a Chainlink answer (8 dp), rounded up', () => {
    expect(weiToCents(10n ** 18n, 2_248_38848816n, 8)).toBe(224_839n);
    expect(weiToCents(10n ** 15n, 2_000_00000000n, 8)).toBe(200n);
    expect(weiToCents(1n, 2_000_00000000n, 8)).toBe(1n);
  });
  it('formats cents', () => {
    expect(centsToUsd(507n)).toBe('$5.07');
    expect(centsToUsd(5n)).toBe('$0.05');
    expect(dollarsToCents(5)).toBe(500n);
    expect(dollarsToCents(0.015)).toBe(2n);
  });
  it('per-transaction cap: at the cap passes, one cent over refuses', () => {
    const limits = { ...DEFAULT_LIMITS, maxTxUsdCents: 500n, maxDailyUsdCents: 2_000n };
    expect(code(() => checkCaps(500n, 0n, limits))).toBe('PASSED');
    expect(code(() => checkCaps(501n, 0n, limits))).toBe('TX_CAP_EXCEEDED');
  });
  it('daily cap: counts what was already spent today', () => {
    const limits = { ...DEFAULT_LIMITS, maxTxUsdCents: 500n, maxDailyUsdCents: 2_000n };
    expect(code(() => checkCaps(500n, 1_500n, limits))).toBe('PASSED');
    expect(code(() => checkCaps(500n, 1_501n, limits))).toBe('DAILY_CAP_EXCEEDED');
  });
  it('slippage: measured against the simulation; at the cap passes, beyond refuses; below the floor refuses', () => {
    expect(code(() => checkSlippage(99n, 100n, 100))).toBe('PASSED');
    expect(code(() => checkSlippage(98n, 100n, 100))).toBe('SLIPPAGE_TOO_HIGH');
    expect(code(() => checkSlippage(101n, 100n, 100))).toBe('SIMULATION_FAILED');
    expect(code(() => checkSlippage(TENTH_BG, TENTH_BG * 1010n / 1000n, 100))).toBe('PASSED');
  });
});

describe('the spend ledger', () => {
  const L = { ...DEFAULT_LIMITS, maxTxUsdCents: 500n, maxDailyUsdCents: 1_000n };
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), 'kit-ledger-'));
    return { ledger: join(root, 'a', 'spend-ledger.json'), sentinel: join(root, 'b', 'spend-ledger.sentinel') };
  };

  it('counts a ROLLING 24 hours, not since UTC midnight', () => {
    const l = new MemoryLedger();
    const t = Date.UTC(2026, 9, 31, 23, 59);
    l.reserveWithin(SELF, 500n, L, t);
    l.reserveWithin(SELF, 300n, L, t + 1);
    // Two minutes later it is a new UTC day, but the 800 still counts.
    expect(code(() => l.reserveWithin(SELF, 300n, L, t + 2 * 60_000))).toBe('DAILY_CAP_EXCEEDED');
    expect(l.spentInWindow(SELF, t + WINDOW_MS - 1)).toBe(800n);
    expect(l.spentInWindow(SELF, t + WINDOW_MS)).toBe(300n);
    expect(l.spentInWindow(SELF, t + WINDOW_MS + 1)).toBe(0n);
    l.reserveWithin(SELF, 300n, L, t + WINDOW_MS + 1);
    expect(l.spentInWindow(ADDR.bg, t)).toBe(0n);
  });

  it('check and reserve are one step: a refused spend records nothing', () => {
    const { ledger, sentinel } = dirs();
    const l = new FileLedger(ledger, sentinel);
    l.reserveWithin(SELF, 400n, L, NOW_MS);
    l.reserveWithin(SELF, 400n, L, NOW_MS + 1);
    expect(code(() => l.reserveWithin(SELF, 400n, L, NOW_MS + 2))).toBe('DAILY_CAP_EXCEEDED');
    expect(code(() => l.reserveWithin(SELF, 501n, L, NOW_MS + 3))).toBe('TX_CAP_EXCEEDED');
    expect(new FileLedger(ledger, sentinel).spentInWindow(SELF, NOW_MS + 4)).toBe(800n);
    expect(statSync(ledger).mode & 0o777).toBe(0o600);
    expect(statSync(sentinel).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(sentinel, 'utf8')).totalCents).toBe('800');
  });

  // A pid that has certainly exited: a child that already ran to completion.
  const DEAD_PID = spawnSync(process.execPath, ['-e', '0']).pid!;
  const age = (p: string, ms: number) => utimesSync(p, new Date(Date.now() - ms), new Date(Date.now() - ms));

  it('waits for, then refuses on, a lock another process holds; breaks one whose holder crashed', () => {
    const { ledger, sentinel } = dirs();
    const l = new FileLedger(ledger, sentinel, 200);
    l.reserveWithin(SELF, 1n, L, NOW_MS);
    writeFileSync(`${ledger}.lock`, `${DEAD_PID} 0\n`);
    expect(code(() => l.reserveWithin(SELF, 1n, L, NOW_MS))).toBe('LEDGER_UNAVAILABLE'); // young: not stale yet
    age(`${ledger}.lock`, 60_000);
    l.reserveWithin(SELF, 1n, L, NOW_MS);
    expect(l.spentInWindow(SELF, NOW_MS)).toBe(2n);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
    expect(existsSync(`${ledger}.lock.break`)).toBe(false);
  });

  it('never breaks an old lock whose holder process is still alive', () => {
    const { ledger, sentinel } = dirs();
    const l = new FileLedger(ledger, sentinel, 150);
    l.reserveWithin(SELF, 1n, L, NOW_MS);
    writeFileSync(`${ledger}.lock`, `${process.pid} 0\n`);
    age(`${ledger}.lock`, 10 * 60_000);
    expect(code(() => l.reserveWithin(SELF, 1n, L, NOW_MS))).toBe('LEDGER_UNAVAILABLE');
    expect(existsSync(`${ledger}.lock`)).toBe(true);
    expect(breakStaleLock(`${ledger}.lock`)).toBe(false);
  });

  it('race: a lock REPLACED after it was judged stale is not removed (the inode is re-checked under the break marker)', () => {
    const { ledger } = dirs();
    mkdirSync(join(ledger, '..'), { recursive: true });
    const lock = `${ledger}.lock`;
    writeFileSync(lock, `${DEAD_PID} 0\n`);
    age(lock, 60_000);
    const judgedStale = statSync(lock);
    // Before this process gets the break marker, another one broke that lock and a third took (and
    // crashed holding) a new one: a different file at the same path, created while the old existed.
    writeFileSync(`${lock}.next`, `${DEAD_PID} 0\n`);
    renameSync(`${lock}.next`, lock);
    age(lock, 60_000);
    expect(statSync(lock).ino).not.toBe(judgedStale.ino);
    expect(breakStaleLock(lock, Date.now, judgedStale)).toBe(true); // retry, but the file it judged is gone
    expect(existsSync(lock)).toBe(true); // the replacement was NOT removed on the old judgement
    expect(existsSync(`${lock}.break`)).toBe(false);
    // Judged on its own, the replacement is stale (holder gone) and is broken.
    expect(breakStaleLock(lock)).toBe(true);
    expect(existsSync(lock)).toBe(false);
    // A replacement whose holder is alive is never touched, whatever it looked like before.
    writeFileSync(lock, `${process.pid} ${Date.now()}\n`);
    age(lock, 60_000);
    expect(breakStaleLock(lock, Date.now, judgedStale)).toBe(false);
    expect(existsSync(lock)).toBe(true);
  });

  it('waits while another process is breaking the lock, and fails CLOSED on a break marker left by a crash', () => {
    const { ledger, sentinel } = dirs();
    const l = new FileLedger(ledger, sentinel, 150);
    l.reserveWithin(SELF, 1n, L, NOW_MS);
    writeFileSync(`${ledger}.lock`, `${DEAD_PID} 0\n`);
    age(`${ledger}.lock`, 60_000);
    writeFileSync(`${ledger}.lock.break`, '');
    expect(code(() => l.reserveWithin(SELF, 1n, L, NOW_MS))).toBe('LEDGER_UNAVAILABLE'); // a fresh marker: someone else is breaking it
    expect(existsSync(`${ledger}.lock`)).toBe(true);
    age(`${ledger}.lock.break`, 60_000);
    let err: GuardRefusal | undefined;
    try { l.reserveWithin(SELF, 1n, L, NOW_MS); } catch (e) { err = e as GuardRefusal; }
    expect(err?.code).toBe('LEDGER_UNAVAILABLE');
    expect(err?.reason).toMatch(/lock-break marker/);
    expect(err?.reason).not.toMatch(/\//);
    unlinkSync(`${ledger}.lock.break`); // the documented manual step
    l.reserveWithin(SELF, 1n, L, NOW_MS);
    expect(l.spentInWindow(SELF, NOW_MS)).toBe(2n);
  });

  it('fails CLOSED when the ledger is deleted, rolled back, corrupted, or loses its sentinel; never names a path', () => {
    const { ledger, sentinel } = dirs();
    const l = new FileLedger(ledger, sentinel);
    l.reserveWithin(SELF, 100n, L, NOW_MS);
    const old = readFileSync(ledger, 'utf8');
    l.reserveWithin(SELF, 100n, L, NOW_MS);
    // rolled back to an older copy
    writeFileSync(ledger, old);
    expect(code(() => l.spentInWindow(SELF, NOW_MS))).toBe('LEDGER_UNAVAILABLE');
    // deleted after it was created
    unlinkSync(ledger);
    let err: unknown;
    try { l.reserveWithin(SELF, 1n, L, NOW_MS); } catch (e) { err = e; }
    expect((err as GuardRefusal).code).toBe('LEDGER_UNAVAILABLE');
    expect((err as GuardRefusal).reason).not.toContain(tmpdir());
    expect((err as GuardRefusal).reason).not.toMatch(/\//);
    // corrupted
    writeFileSync(ledger, '{not json');
    expect(code(() => l.spentInWindow(SELF, NOW_MS))).toBe('LEDGER_UNAVAILABLE');
    // sentinel removed while the ledger stays
    const d2 = dirs();
    const l2 = new FileLedger(d2.ledger, d2.sentinel);
    l2.reserveWithin(SELF, 1n, L, NOW_MS);
    unlinkSync(d2.sentinel);
    expect(code(() => l2.spentInWindow(SELF, NOW_MS))).toBe('LEDGER_UNAVAILABLE');
    // the documented reset: delete BOTH
    unlinkSync(d2.ledger);
    expect(l2.spentInWindow(SELF, NOW_MS)).toBe(0n);
  });

  it('refuses a sentinel in the same directory as the ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'kit-ledger-'));
    expect(() => new FileLedger(join(root, 'l.json'), join(root, 's.json'))).toThrow(/different directory/);
  });
});

describe('caps on a real swap flow', () => {
  it('a buy above the per-transaction cap is refused before anything is approved', async () => {
    const chain = new FakeChain();
    chain.setBal(ADDR.usdc, 100_000_000n);
    const w = walletOn(chain, { maxTxUsdCents: 100n });
    await expect(w.prepareSwap({ to: ADDR.routerV1, data: v1Entry({ amountIn: 1_060_000n }), value: 0n }, { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, minOutFloor: TENTH_BG }))
      .rejects.toMatchObject({ code: 'TX_CAP_EXCEEDED' });
    expect(chain.sent).toHaveLength(0);
  });
  it('the daily cap accumulates across swaps and refuses the one that would cross it', async () => {
    const chain = new FakeChain();
    chain.setBal(ADDR.usdc, 100_000_000n);
    const w = walletOn(chain, { maxTxUsdCents: 200n, maxDailyUsdCents: 300n });
    const buy = async () => w.executeSwap(await w.prepareSwap({ to: ADDR.routerV1, data: v1Entry({ amountIn: 1_060_000n }), value: 0n }, { tokenIn: ADDR.usdc, tokenOut: ADDR.bg, minOutFloor: TENTH_BG }));
    await buy();
    await buy();
    expect(w.spentLast24hCents()).toBe(212n);
    await expect(buy()).rejects.toMatchObject({ code: 'DAILY_CAP_EXCEEDED' });
  });
});

describe('config limits', () => {
  const base = { signer: { type: 'cdp', accountName: 'mineswap-agent' } };
  it('defaults: 1% slippage, $5/tx, $20 per 24 h, 2.5M gas, 0.5 gwei, ledger and sentinel in different directories', () => {
    const c = resolveConfig(base);
    expect(c.limits).toMatchObject({ maxSlippageBps: 100, maxTxUsdCents: 500n, maxDailyUsdCents: 2_000n, maxGasPerTx: 2_500_000n, maxFeePerGasWei: 500_000_000n });
    expect(c.ledgerPath).not.toBe(c.ledgerSentinelPath);
    expect(c.rpcHost).toBe('mainnet.base.org');
  });
  it('refuses a slippage above the hard ceiling, a tx cap above the daily cap, unknown keys and plain-http RPC', () => {
    expect(() => resolveConfig({ ...base, limits: { maxSlippageBps: 501 } })).toThrow(/maxSlippageBps/);
    expect(() => resolveConfig({ ...base, limits: { maxTxUsd: 50, maxDailyUsd: 10 } })).toThrow(/maxTxUsd/);
    expect(() => resolveConfig({ ...base, extra: true })).toThrow(/invalid kit config/);
    expect(() => resolveConfig({ ...base, rpcUrl: 'http://example.com' })).toThrow(/https/);
    expect(() => resolveConfig({ signer: { type: 'local-test', keyFile: '/tmp/k' } })).toThrow(/acknowledgeTestOnly/);
  });
});
