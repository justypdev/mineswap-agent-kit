import { toFunctionSelector, getAddress, keccak256, type PublicClient } from 'viem';
import { describe, expect, it } from 'vitest';
import { ERC20_ABI, MINE_BURN_ENTRY_ABI, ROUTER_V1_ABI, ROUTER_V2_ABI } from '../src/abis.js';
import { assertPins, verifyPins } from '../src/guard/verify-pins.js';
import { ADDR, CODE_HASH, NAMED_REFUSALS, SELECTOR } from '../src/pins.js';

const fn = (abi: readonly any[], name: string) => abi.find((f) => f.type === 'function' && f.name === name);

describe('pins', () => {
  it('every selector equals the one computed from the ABI the kit decodes with', () => {
    expect(toFunctionSelector(fn(ERC20_ABI, 'approve'))).toBe(SELECTOR.approve);
    expect(toFunctionSelector(fn(ROUTER_V1_ABI, 'swapExactInPath'))).toBe(SELECTOR.v1SwapExactInPath);
    expect(toFunctionSelector(fn(ROUTER_V1_ABI, 'swapExactTokensForTokens'))).toBe(SELECTOR.v1SwapExactTokensForTokens);
    expect(toFunctionSelector(fn(ROUTER_V2_ABI, 'swapExactIn'))).toBe(SELECTOR.v2SwapExactIn);
    expect(toFunctionSelector(fn(ROUTER_V2_ABI, 'swapExactOut'))).toBe(SELECTOR.v2SwapExactOut);
    expect(toFunctionSelector(fn(MINE_BURN_ENTRY_ABI, 'activate'))).toBe(SELECTOR.activate);
    expect(SELECTOR).toEqual({ approve: '0x095ea7b3', v1SwapExactInPath: '0xa80b96c9', v1SwapExactTokensForTokens: '0x38ed1739', v2SwapExactIn: '0xfbd703f9', v2SwapExactOut: '0x9bfb1e49', activate: '0x0f15f4c0' });
  });
  it('every named refusal selector matches its signature', () => {
    for (const [sel, sig] of Object.entries(NAMED_REFUSALS)) expect(toFunctionSelector(`function ${sig}`)).toBe(sel);
  });
  it('addresses are checksummed, and are the ones verified on chain on 2026-10-31', () => {
    for (const a of Object.values(ADDR)) expect(getAddress(a)).toBe(a);
    expect(ADDR).toMatchObject({
      routerV1: '0x7f0f058c731b479A214dA459a1AC4CF98d568Bf0', routerV2: '0xE4cB28BcBA75899764cd8B5c52a51f20B29afEE9',
      bg: '0x36b712A629095234F2196BbB000D1b96C12Ce78e', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      mineBurnEntry: '0xF121e113330A2ede61c81B8887b7092F03566037', goldMineNft: '0x4F8f97e10E2D89Bc118d6fdfe74d1C96A821E4e3',
    });
    expect(Object.isFrozen(ADDR) && Object.isFrozen(CODE_HASH) && Object.isFrozen(SELECTOR)).toBe(true);
  });
});

describe('startup verification', () => {
  const client = (code: `0x${string}`, chainId = 8453) => ({
    getChainId: async () => chainId,
    getBlockNumber: async () => 1n,
    getCode: async () => code,
    readContract: async () => { throw new Error('no'); },
  }) as unknown as PublicClient;

  it('refuses to start when code at a pin does not hash to the pinned value, naming every failure', async () => {
    const r = await verifyPins(client('0x6080'));
    expect(r.checks.filter((c) => !c.ok).length).toBeGreaterThanOrEqual(Object.keys(ADDR).length);
    expect(() => assertPins(r)).toThrow(/PIN_MISMATCH.*code:routerV1/);
    expect(keccak256('0x6080')).not.toBe(CODE_HASH.routerV1);
  });
  it('refuses another chain', async () => {
    const r = await verifyPins(client('0x', 1));
    expect(r.checks.find((c) => c.name === 'chainId')!.ok).toBe(false);
  });
});
