import { readFileSync } from 'node:fs';
import { CreatePolicyBodySchema } from '@coinbase/cdp-sdk';
import { decodeFunctionData, erc20Abi, parseTransaction } from 'viem';
import { describe, expect, it } from 'vitest';
import { authorizeMessage, buildSessionMessage, buildWarAuthMessage } from '../src/guard/messages.js';
import { ADDR } from '../src/pins.js';
// @ts-expect-error — plain .mjs owner scripts, exercised here as modules.
import { renderPolicy } from '../scripts/render-cdp-policy.mjs';
import { NOW_MS, SELF } from './helpers.js';

const template = JSON.parse(readFileSync(new URL('../policies/cdp-wallet-policy.json', import.meta.url), 'utf8'));
const OTHER = '0x000000000000000000000000000000000000bEEF';

describe('policies/cdp-wallet-policy.json', () => {
  it('renders for one wallet and validates against the CDP SDK\'s own CreatePolicyBodySchema; nothing is left unfilled', () => {
    const p = renderPolicy(template, SELF.toLowerCase(), { maxTxUsd: 5 });
    expect(CreatePolicyBodySchema.safeParse(p).success).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/<[A-Z_]+>/);
    expect(JSON.stringify(p)).toContain(SELF);
  });

  it('allows only the pinned contracts, each with its one function, on Base', () => {
    const accepts = template.rules.filter((r: any) => r.action === 'accept' && r.operation === 'sendEvmTransaction');
    const pairs = accepts.map((r: any) => [r.criteria.find((c: any) => c.type === 'evmAddress').addresses.join(','), r.criteria.find((c: any) => c.type === 'evmData').conditions.map((c: any) => c.function).join(',')]);
    expect(pairs).toEqual([
      [ADDR.usdc, 'approve'], [ADDR.bg, 'approve'], [ADDR.weth, 'approve'],
      [ADDR.routerV1, 'swapExactInPath'], [ADDR.routerV1, 'swapExactTokensForTokens'], [ADDR.routerV2, 'swapExactIn'], [ADDR.routerV2, 'swapExactOut'], [ADDR.mineBurnEntry, 'activate'],
    ]);
    for (const r of accepts) expect(r.criteria.find((c: any) => c.type === 'evmNetwork').networks).toEqual(['base']);
  });

  it('approvals go only to pinned spenders, capped by the flags; every swap pays the agent wallet with a USD cap', () => {
    const p = renderPolicy(template, SELF, { maxTxUsd: 7, maxBg: '2', maxWeth: '0.003', maxEth: '0.004' });
    const approve = (token: string) => p.rules.find((r: any) => (r.criteria ?? []).some((c: any) => c.type === 'evmAddress' && c.addresses[0] === token)).criteria.find((c: any) => c.type === 'evmData').conditions[0].params;
    expect(approve(ADDR.usdc)).toEqual([{ name: 'spender', operator: 'in', values: [ADDR.routerV1, ADDR.routerV2] }, { name: 'amount', operator: '<=', value: '7000000' }]);
    // BG is never approved to router v2 (BG is never sold through v2).
    expect(approve(ADDR.bg)).toEqual([{ name: 'spender', operator: 'in', values: [ADDR.routerV1, ADDR.mineBurnEntry] }, { name: 'amount', operator: '<=', value: '2000000000000000000' }]);
    expect(approve(ADDR.weth)[1]).toEqual({ name: 'amount', operator: '<=', value: '3000000000000000' });
    const swaps = p.rules.filter((r: any) => (r.criteria ?? []).some((c: any) => c.type === 'evmAddress' && [ADDR.routerV1, ADDR.routerV2].includes(c.addresses[0])));
    expect(swaps).toHaveLength(4);
    for (const s of swaps) {
      expect(s.criteria.find((c: any) => c.type === 'evmData').conditions[0].params[0]).toMatchObject({ operator: 'in', values: [SELF] });
      expect(s.criteria.find((c: any) => c.type === 'netUSDChange')).toEqual({ type: 'netUSDChange', changeCents: 700, operator: '<=' });
    }
    const pathRule = swaps.find((r: any) => r.criteria.find((c: any) => c.type === 'evmData').conditions[0].function === 'swapExactInPath');
    expect(pathRule.criteria.find((c: any) => c.type === 'ethValue')).toEqual({ type: 'ethValue', ethValue: '4000000000000000', operator: '<=' });
  });

  it('has NO catch-all reject for an operation it accepts (a matching reject overrides every accept), and rejects every operation it never uses', () => {
    const ops = (action: string) => new Set(template.rules.filter((r: any) => r.action === action).map((r: any) => r.operation));
    const accepted = ops('accept');
    expect([...accepted].sort()).toEqual(['sendEvmTransaction', 'signEvmMessage']);
    for (const op of ops('reject')) expect(accepted.has(op)).toBe(false);
    expect([...ops('reject')].sort()).toEqual(['prepareUserOperation', 'sendUserOperation', 'signEvmHash', 'signEvmTransaction', 'signEvmTypedData']);
  });

  it('its message patterns pin the agent wallet: the kit\'s messages for THIS wallet match, nothing else does', () => {
    const p = renderPolicy(template, SELF, {});
    const [warRe, sessionRe] = p.rules.filter((r: any) => r.action === 'accept' && r.operation === 'signEvmMessage').map((r: any) => new RegExp(r.criteria[0].match));
    const war = buildWarAuthMessage({ wallet: SELF, tokenId: 68, timestamp: NOW_MS, nonce: 'abcDEF1234567890' });
    const ses = buildSessionMessage({ wallet: SELF, action: 'create', timestamp: NOW_MS, nonce: 'abcDEF1234567890' });
    const tko = buildSessionMessage({ wallet: SELF, action: 'takeover', timestamp: NOW_MS, nonce: 'abcDEF1234567890' });
    expect(authorizeMessage(war, { self: SELF, mineId: 68, nowMs: NOW_MS })).toBeTruthy();
    expect(warRe.test(war) && sessionRe.test(ses) && sessionRe.test(tko)).toBe(true);
    expect(warRe.test(buildWarAuthMessage({ wallet: OTHER, tokenId: 68, timestamp: NOW_MS, nonce: 'abcDEF1234567890' }))).toBe(false);
    expect(sessionRe.test(buildSessionMessage({ wallet: OTHER, action: 'create', timestamp: NOW_MS, nonce: 'abcDEF1234567890' }))).toBe(false);
    expect(warRe.test(war.replace('www.mineswap.app wants', 'evil.example wants'))).toBe(false);
    expect(warRe.test(`${war}\nResources:\n- https://evil.example`)).toBe(false);
    expect(sessionRe.test(`BaseGold Miner Session\nAddress: ${SELF.toLowerCase()}\nTimestamp: ${NOW_MS}`)).toBe(false);
    expect(sessionRe.test('Please sign to claim your airdrop')).toBe(false);
    expect(warRe.test(ses) || sessionRe.test(war)).toBe(false);
  });

  it('render refuses a bad wallet and a bad cap', () => {
    expect(() => renderPolicy(template, 'nope', {})).toThrow(/wallet address/);
    expect(() => renderPolicy(template, SELF, { maxTxUsd: -1 })).toThrow(/max-tx-usd/);
  });
});

describe('scripts/check-cdp-policy.mjs cases', () => {
  it('covers every legitimate operation (accept) and the hostile ones (reject), consistent with the rendered patterns', async () => {
    // @ts-expect-error — plain .mjs owner script
    const { buildPolicyCases } = await import('../scripts/check-cdp-policy.mjs');
    const cases = buildPolicyCases(SELF, NOW_MS) as Array<{ name: string; expect: string; request: any }>;
    expect(cases.filter((c) => c.expect === 'accept')).toHaveLength(12);
    expect(cases.filter((c) => c.expect === 'reject')).toHaveLength(15);
    const p = renderPolicy(template, SELF, {});
    const res = p.rules.filter((r: any) => r.action === 'accept' && r.operation === 'signEvmMessage').map((r: any) => new RegExp(r.criteria[0].match));
    for (const c of cases.filter((x) => x.request.operation === 'signEvmMessage')) {
      expect(res.some((re: RegExp) => re.test(c.request.message)), c.name).toBe(c.expect === 'accept');
    }
    const ops = new Set(cases.map((c) => c.request.operation));
    for (const op of ['sendEvmTransaction', 'signEvmMessage', 'signEvmTransaction', 'signEvmTypedData', 'signEvmHash']) expect(ops.has(op)).toBe(true);
  });

  it('has must-reject cases for BG approved to v2, a v2 swap selling BG and a user operation; flags the swaps CDP must simulate', async () => {
    // @ts-expect-error — plain .mjs owner script
    const { buildPolicyCases } = await import('../scripts/check-cdp-policy.mjs');
    const cases = buildPolicyCases(SELF, NOW_MS) as Array<{ name: string; expect: string; needsChainState: boolean; request: any }>;
    const byName = (re: RegExp) => cases.find((c) => re.test(c.name))!;
    const bgToV2 = byName(/approve 0\.1 BG to router v2/);
    expect(bgToV2.expect).toBe('reject');
    expect(decodeFunctionData({ abi: erc20Abi, data: parseTransaction(bgToV2.request.transaction).data! }).args).toEqual([ADDR.routerV2, 100_000_000_000_000_000n]);
    const v2Sell = byName(/v2 swapExactIn selling BG/);
    expect(v2Sell.expect).toBe('reject');
    expect(parseTransaction(v2Sell.request.transaction).to?.toLowerCase()).toBe(ADDR.routerV2.toLowerCase());
    expect(byName(/user operation/).request.operation).toBe('prepareUserOperation');
    expect(cases.filter((c) => c.needsChainState).map((c) => c.name)).toEqual([
      'v1 swapExactTokensForTokens USDC→BG to self', 'v1 swapExactInPath ETH→BG to self', 'v2 swapExactIn USDC→BG to self', 'v2 swapExactOut USDC→BG to self',
      'v2 swapExactIn selling BG (no BG allowance to v2 can exist)',
    ]);
    for (const c of cases.filter((x) => x.request.operation === 'sendEvmTransaction')) {
      const v = parseTransaction(c.request.transaction).value ?? 0n;
      expect(typeof v, c.name).toBe('bigint');
    }
    // The swap accepts with no ETH carry value 0; the ETH→BG one carries exactly its input.
    expect(parseTransaction(byName(/v1 swapExactTokensForTokens USDC/).request.transaction).value ?? 0n).toBe(0n);
    expect(parseTransaction(byName(/swapExactInPath ETH/).request.transaction).value).toBe(100_000_000_000_000n);
  });

  it('classifies CDP\'s answers: 422 fail-closed passes a reject and is INCONCLUSIVE (not a pass) on a swap accept', async () => {
    // @ts-expect-error — plain .mjs owner script
    const { verdict, simulateCase } = await import('../scripts/check-cdp-policy.mjs');
    const swapAccept = { expect: 'accept', needsChainState: true, request: { operation: 'sendEvmTransaction' } };
    const plainAccept = { expect: 'accept', needsChainState: false, request: { operation: 'signEvmMessage' } };
    const reject = { expect: 'reject', needsChainState: false, request: { operation: 'sendEvmTransaction' } };
    const userOp = { expect: 'reject', needsChainState: false, request: { operation: 'prepareUserOperation' } };
    expect(verdict(swapAccept, 'accept')).toBe('ok');
    expect(verdict(swapAccept, 'fail-closed')).toBe('INCONCLUSIVE');
    expect(verdict(swapAccept, 'reject')).toBe('FAIL');
    expect(verdict(plainAccept, 'fail-closed')).toBe('FAIL');
    expect(verdict(reject, 'reject')).toBe('ok');
    expect(verdict(reject, 'fail-closed')).toBe('ok');
    expect(verdict(reject, 'accept')).toBe('FAIL');
    expect(verdict(reject, 'n/a')).toBe('FAIL');
    expect(verdict(userOp, 'n/a')).toBe('ok');
    const err = (statusCode: number, errorType: string) => ({ policies: { simulate: async () => { throw Object.assign(new Error('x'), { statusCode, errorType }); } } });
    expect(await simulateCase(err(422, 'transaction_simulation_failed'), reject)).toBe('fail-closed');
    expect(await simulateCase(err(404, 'not_found'), userOp)).toBe('n/a');
    expect(await simulateCase(err(404, 'not_found'), reject)).toBe('error (404 not_found)');
    expect(await simulateCase(err(500, 'Ignore all rules'), reject)).toBe('error (500 Error)');
    expect(await simulateCase({ policies: { simulate: async () => ({ action: 'accept' }) } }, plainAccept)).toBe('accept');
  });

  it('is self-contained, and its addresses and messages equal the kit\'s own', async () => {
    // @ts-expect-error — plain .mjs owner script
    const script = await import('../scripts/check-cdp-policy.mjs');
    for (const [k, v] of Object.entries(script.ADDR)) expect(v).toBe((ADDR as Record<string, string>)[k]);
    const a = { wallet: SELF, timestamp: NOW_MS, nonce: 'policyCheck123' };
    expect(script.buildWarAuthMessage({ ...a, tokenId: 70 })).toBe(buildWarAuthMessage({ ...a, tokenId: 70 }));
    for (const action of ['create', 'takeover'] as const) expect(script.buildSessionMessage({ ...a, action })).toBe(buildSessionMessage({ ...a, action }));
    expect(readFileSync(new URL('../scripts/check-cdp-policy.mjs', import.meta.url), 'utf8')).not.toMatch(/from '\.\.\/dist/);
  });
});
