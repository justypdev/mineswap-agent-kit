/**
 * The routers' OWNER-CONTROLLED state, re-read before every swap and activation, and at startup.
 *
 * Both routers are owned by one EOA. During a long session its key could register a pool on v1
 * (addPool), deactivate one (setPoolActive), move the hop pool or the V4 adapter, change the quoter,
 * add a v2 adapter, or hand over ownership. Each of these changes what router v1's UniV2 entry (the
 * REFERENCE price) or a router swap does, so the kit compares ALL of it with pins.ts before it signs
 * anything and refuses on any difference (ROUTER_STATE_CHANGED).
 *
 * One Multicall3 `aggregate3` eth_call reads everything, so the check costs one RPC request.
 * Multicall3's own code hash is pinned and checked at startup.
 *
 * What this cannot see: a v2 hook allowed after this release (`hookAllowed` is a mapping and cannot
 * be enumerated), and an owner change that lands between this read and the swap's inclusion in a
 * block (seconds). BG is never sold through v2, and every floor is held to the reference.
 */
import { type Address, type PublicClient } from 'viem';
import { CHAINLINK_ABI, GOLD_MINE_NFT_ABI, MINE_BURN_ENTRY_ABI, ROUTER_V1_STATE_ABI, ROUTER_V2_ABI, ROUTER_V2_STATE_ABI } from '../abis.js';
import { ADDR, MINE_BURN_AMOUNT, ROUTER_STATE, V1_REGISTRY, sameAddress } from '../pins.js';
import { refuse } from './refusal.js';

export interface StateCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const ZERO: Address = '0x0000000000000000000000000000000000000000';

interface Read {
  readonly name: string;
  readonly address: Address;
  readonly abi: readonly unknown[];
  readonly functionName: string;
  readonly args?: readonly unknown[];
  readonly ok: (v: never) => boolean;
  readonly show?: (v: never) => string;
}

interface PoolInfo { token0: Address; feeBps: number; kind: number; active: boolean; isBgWeth: boolean; token1: Address }

const is = (want: Address) => (v: Address) => sameAddress(v, want);
const short = (v: unknown): string => String(v).slice(0, 80);

/** Every single-value read, with its expected value. Names are stable (reports and tests use them). */
function singleReads(): Read[] {
  const S = ROUTER_STATE;
  const r1 = (functionName: string, ok: Read['ok'], show?: Read['show']): Read =>
    ({ name: `routerV1.${functionName}`, address: ADDR.routerV1, abi: ROUTER_V1_STATE_ABI, functionName, ok, show });
  const r2 = (label: string, functionName: string, ok: Read['ok'], args?: readonly unknown[], show?: Read['show']): Read =>
    ({ name: `routerV2.${label}`, address: ADDR.routerV2, abi: ROUTER_V2_STATE_ABI, functionName, args, ok, show });
  return [
    { name: 'entry.bg', address: ADDR.mineBurnEntry, abi: MINE_BURN_ENTRY_ABI, functionName: 'bg', ok: is(ADDR.bg) as Read['ok'] },
    { name: 'entry.nft', address: ADDR.mineBurnEntry, abi: MINE_BURN_ENTRY_ABI, functionName: 'nft', ok: is(ADDR.goldMineNft) as Read['ok'] },
    { name: 'entry.BURN_AMOUNT', address: ADDR.mineBurnEntry, abi: MINE_BURN_ENTRY_ABI, functionName: 'BURN_AMOUNT', ok: ((v: bigint) => v === MINE_BURN_AMOUNT) as Read['ok'] },
    { name: 'nft.goldVein', address: ADDR.goldMineNft, abi: GOLD_MINE_NFT_ABI, functionName: 'goldVein', ok: is(ADDR.mineBurnEntry) as Read['ok'] },
    { name: 'routerV2.BG', address: ADDR.routerV2, abi: ROUTER_V2_ABI, functionName: 'BG', ok: is(ADDR.bg) as Read['ok'] },
    { name: 'routerV2.USDC', address: ADDR.routerV2, abi: ROUTER_V2_ABI, functionName: 'USDC', ok: is(ADDR.usdc) as Read['ok'] },
    { name: 'routerV2.WETH', address: ADDR.routerV2, abi: ROUTER_V2_ABI, functionName: 'WETH', ok: is(ADDR.weth) as Read['ok'] },

    r1('owner', is(S.owner) as Read['ok']),
    r1('pendingOwner', is(ZERO) as Read['ok']),
    r1('hopPool', is(S.v1.hopPool) as Read['ok']),
    r1('onchainQuoter', is(S.v1.onchainQuoter) as Read['ok']),
    r1('v4Adapter', is(S.v1.v4Adapter) as Read['ok']),
    r1('feeCollector', is(S.v1.feeCollector) as Read['ok']),
    r1('feeBps', ((v: number) => Number(v) === S.v1.feeBps) as Read['ok']),
    r1('paused', ((v: boolean) => v === false) as Read['ok']),
    r1('getPools',
      ((v: readonly Address[]) => v.length === V1_REGISTRY.length && v.every((p, i) => sameAddress(p, V1_REGISTRY[i]!.pool))) as Read['ok'],
      ((v: readonly Address[]) => `${v.length} pools`) as Read['show']),

    r2('owner', 'owner', is(S.owner) as Read['ok']),
    r2('pendingOwner', 'pendingOwner', is(ZERO) as Read['ok']),
    r2('adapterCount', 'adapterCount', ((v: number) => Number(v) === S.v2.adapters.length) as Read['ok']),
    r2('adapters', 'adapters',
      ((v: readonly Address[]) => v.length === S.v2.adapters.length && v.every((a, i) => sameAddress(a, S.v2.adapters[i]))) as Read['ok'],
      undefined, ((v: readonly Address[]) => `${v.length} adapters`) as Read['show']),
    ...S.v2.payStyles.map((style, i) => r2(`payStyleOf(${i + 1})`, 'payStyleOf', ((v: number) => Number(v) === style) as Read['ok'], [i + 1])),
    ...S.v2.allowedHooks.map((hook) => r2(`hookAllowed(${hook})`, 'hookAllowed', ((v: boolean) => v === true) as Read['ok'], [hook])),

    { name: 'chainlink.description', address: ADDR.chainlinkEthUsd, abi: CHAINLINK_ABI, functionName: 'description', ok: ((v: string) => v === 'ETH / USD') as Read['ok'] },
    { name: 'chainlink.decimals', address: ADDR.chainlinkEthUsd, abi: CHAINLINK_ABI, functionName: 'decimals', ok: ((v: number) => Number(v) === 8) as Read['ok'] },
    { name: 'sequencer.description', address: ADDR.sequencerUptime, abi: CHAINLINK_ABI, functionName: 'description', ok: ((v: string) => v === 'L2 Sequencer Uptime Status Feed') as Read['ok'] },
  ];
}

/** Read everything in ONE Multicall3 call and compare it with the pins. Never throws. */
export async function readRouterState(client: PublicClient): Promise<StateCheck[]> {
  const singles = singleReads();
  const poolInfo = V1_REGISTRY.map((e) => ({ address: ADDR.routerV1, abi: ROUTER_V1_STATE_ABI, functionName: 'getPoolInfo', args: [e.pool] }));
  const aeroOf = V1_REGISTRY.map((e) => ({ address: ADDR.routerV1, abi: ROUTER_V1_STATE_ABI, functionName: 'aeroFactoryOf', args: [e.pool] }));
  const contracts = [
    ...singles.map(({ address, abi, functionName, args }) => ({ address, abi, functionName, ...(args ? { args } : {}) })),
    ...poolInfo,
    ...aeroOf,
  ];
  let results: ReadonlyArray<{ status: 'success'; result: unknown } | { status: 'failure'; error: unknown }>;
  try {
    // batchSize 0: one aggregate3 call, never chunked.
    results = await client.multicall({ contracts: contracts as never, allowFailure: true, multicallAddress: ADDR.multicall3, batchSize: 0 }) as never;
    if (!Array.isArray(results) || results.length !== contracts.length) throw new Error('short multicall result');
  } catch {
    return [...singles.map((s) => s.name), 'routerV1.poolInfo'].map((name) => ({ name, ok: false, detail: 'the state read failed' }));
  }
  const checks: StateCheck[] = singles.map((s, i) => {
    const r = results[i]!;
    if (r.status !== 'success') return { name: s.name, ok: false, detail: 'read reverted' };
    let ok = false;
    try { ok = s.ok(r.result as never); } catch { ok = false; }
    return { name: s.name, ok, detail: short(s.show ? s.show(r.result as never) : r.result) };
  });
  // The registry entries, pool by pool: info and Aerodrome factory.
  let bad: string | null = null;
  V1_REGISTRY.forEach((e, i) => {
    if (bad) return;
    const info = results[singles.length + i]!;
    const aero = results[singles.length + V1_REGISTRY.length + i]!;
    if (info.status !== 'success' || aero.status !== 'success') { bad = `pool ${e.pool}: read reverted`; return; }
    const v = info.result as PoolInfo;
    const same = sameAddress(v.token0, e.token0) && sameAddress(v.token1, e.token1) && Number(v.feeBps) === e.feeBps && Number(v.kind) === e.kind
      && v.active === e.active && v.isBgWeth === e.isBgWeth && sameAddress(aero.result as Address, e.aeroFactory);
    if (!same) bad = `pool ${e.pool} differs (active ${String(v.active)}, kind ${Number(v.kind)}, fee ${Number(v.feeBps)})`;
  });
  checks.push({ name: 'routerV1.poolInfo', ok: bad === null, detail: bad ?? `${V1_REGISTRY.length} pools match` });
  return checks;
}

/**
 * Refuses (ROUTER_STATE_CHANGED) unless every owner-controlled value still equals its pin.
 * Called before every swap (prepare and execute) and every activation.
 */
export async function assertRouterState(client: PublicClient): Promise<void> {
  const failed = (await readRouterState(client)).filter((c) => !c.ok);
  if (failed.length) {
    const list = failed.slice(0, 6).map((c) => `${c.name} (${c.detail})`).join('; ');
    refuse('ROUTER_STATE_CHANGED',
      `the routers' owner-controlled state no longer matches this release's pins: ${list}${failed.length > 6 ? `; and ${failed.length - 6} more` : ''}. Nothing is signed until the kit is re-released against the new state`);
  }
}
