/**
 * Every address, code hash and selector the kit is allowed to touch, compiled in.
 *
 * Nothing that arrives at runtime (a server response, a tool argument, the prompt, a config file)
 * can add to or change this list. `verifyPins()` re-reads every entry from the chain at startup and
 * the kit refuses to run when one does not match.
 *
 * Provenance (all read on Base mainnet on 2026-10-31, head block 53,332,249; see README "Pinned
 * contracts"):
 *   - code hashes are keccak256(eth_getCode(address, latest));
 *   - router v2's `BG()`, `USDC()`, `WETH()`, `FEE_BPS()` and `adapters()` were read back;
 *   - MineBurnEntry's `bg()`, `nft()` and `BURN_AMOUNT()` were read back, and the Mine NFT's
 *     `goldVein()` returns MineBurnEntry;
 *   - each selector below was found as a PUSH4 operand in the target's runtime bytecode.
 */
import type { Address, Hex } from 'viem';

export const BASE_CHAIN_ID = 8453 as const;

/** The native-ETH sentinel both routers and the quote API use for tokenIn/tokenOut. */
export const ETH_SENTINEL: Address = '0x0000000000000000000000000000000000000000';

export const ADDR = Object.freeze({
  /** MineSwap split router (v1). Serves every pair in its registry, USDC→BG included. */
  routerV1: '0x7f0f058c731b479A214dA459a1AC4CF98d568Bf0',
  /** MineSwap Router v2, deployed 2026-10-26 (creation block 53,098,455). */
  routerV2: '0xE4cB28BcBA75899764cd8B5c52a51f20B29afEE9',
  /** BaseGold (BG), 18 decimals, burnable, no EIP-2612 permit. */
  bg: '0x36b712A629095234F2196BbB000D1b96C12Ce78e',
  /** USDC on Base (Circle FiatToken PROXY; the implementation behind it is upgradeable by Circle). */
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  /** WETH predeploy. */
  weth: '0x4200000000000000000000000000000000000006',
  /** Burn-to-mine entry: activate() burns exactly 0.1 BG and mints a Gold Mine to msg.sender. */
  mineBurnEntry: '0xF121e113330A2ede61c81B8887b7092F03566037',
  /** Gold Mine NFT (ERC-721; transferable, so the kit refuses every NFT transfer/approval). */
  goldMineNft: '0x4F8f97e10E2D89Bc118d6fdfe74d1C96A821E4e3',
  /** Chainlink ETH/USD aggregator proxy on Base (8 decimals), used only to value ETH/WETH spend. */
  chainlinkEthUsd: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  /** Chainlink L2 Sequencer Uptime Status Feed on Base (answer 0 = up). */
  sequencerUptime: '0xBCF85224fc0756B9Fa45aA7892530B47e10b6433',
  /** Multicall3 (read-only): batches the per-swap re-read of the routers' owner-controlled state. */
  multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11',
} as const satisfies Record<string, Address>);

export type PinName = keyof typeof ADDR;

/** keccak256 of each contract's runtime code. A proxy is pinned by ITS code, never its implementation. */
export const CODE_HASH: Readonly<Record<PinName, Hex>> = Object.freeze({
  routerV1: '0x49d5faee0bc07d3e87d8f7578ce238773c05360ff2bd8ed5b0b13de7b162a5c6',
  routerV2: '0x81c6120a2fa9dec8b2fc254d3c53903269c0e292904048c96e98ab12c4e88c75',
  bg: '0x4abeb4c3c81950f50e745d07a4ec31a0ebc7bb1368b1029ab52b6b96bffb900d',
  usdc: '0xa6705a10bb756b5dea144591118be77d7af0c3eee3bf2dfe2583dcb0364fefab',
  weth: '0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c',
  mineBurnEntry: '0xcdc216ab374ca81b65d0a246af7bcba7a9f5d22fec52c4f06b0044cbef27d731',
  goldMineNft: '0x89531dbb3cfd373f186023828bcd14bcc14717743580eaf9e3931a86d56f1bac',
  chainlinkEthUsd: '0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2',
  // Same EACAggregatorProxy bytecode as the ETH/USD proxy; told apart by description().
  sequencerUptime: '0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2',
  multicall3: '0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891',
});

/**
 * Router v1's pool registry, entry by entry: getPools() in order, getPoolInfo(pool) and
 * aeroFactoryOf(pool), read on Base on 2026-10-31 (block 53,349,051). The REFERENCE price is router
 * v1's own UniV2 entry over these pools, so the kit refuses to sign when any entry differs (a pool
 * added, removed, re-ordered, (de)activated or re-registered).
 */
export interface V1PoolEntry {
  readonly pool: Address;
  readonly token0: Address;
  readonly token1: Address;
  readonly feeBps: number;
  /** 0 = V2-style, 1 = V3-style, 2 = V4 (through v4Adapter). */
  readonly kind: number;
  readonly active: boolean;
  readonly isBgWeth: boolean;
  readonly aeroFactory: Address;
}
export const V1_REGISTRY: readonly V1PoolEntry[] = Object.freeze(([
  { pool: '0x4cC6BC0a0244fFAc5f239a9Ac5b8227078575581', token0: '0x36b712A629095234F2196BbB000D1b96C12Ce78e', token1: '0x4200000000000000000000000000000000000006', feeBps: 30, kind: 0, active: true, isBgWeth: true, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x7Cc79B882dfE590a81c447745D72bE569e0b2a4b', token0: '0x36b712A629095234F2196BbB000D1b96C12Ce78e', token1: '0x4200000000000000000000000000000000000006', feeBps: 30, kind: 0, active: true, isBgWeth: true, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x5E2b6A46ea72c6131d6Cd5150Eb11d3dd9c9eAd2', token0: '0x36b712A629095234F2196BbB000D1b96C12Ce78e', token1: '0x4200000000000000000000000000000000000006', feeBps: 0, kind: 0, active: true, isBgWeth: true, aeroFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
  { pool: '0xbDd5EC6263F92278ea5553731B22a2db0453cceB', token0: '0x36b712A629095234F2196BbB000D1b96C12Ce78e', token1: '0x4200000000000000000000000000000000000006', feeBps: 30, kind: 1, active: true, isBgWeth: true, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xf66C3A84be44ECA21FA510F04fbD9Bfe79Da6d67', token0: '0x36b712A629095234F2196BbB000D1b96C12Ce78e', token1: '0x4200000000000000000000000000000000000006', feeBps: 25, kind: 0, active: true, isBgWeth: true, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xB7c567F80b8cE7fAf50A093edc8860558f376A39', token0: '0x36b712A629095234F2196BbB000D1b96C12Ce78e', token1: '0x4200000000000000000000000000000000000006', feeBps: 16, kind: 0, active: false, isBgWeth: true, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224', token0: '0x4200000000000000000000000000000000000006', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x7AeA2E8A3843516afa07293a10Ac8E49906dabD1', token0: '0x4200000000000000000000000000000000000006', token1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x01784ef301D79e4B2DF3a21ad9a536d4cF09A5Ce', token0: '0x4200000000000000000000000000000000000006', token1: '0xacfE6019Ed1A7Dc6f7B508C02d1b04ec88cC21bf', feeBps: 0, kind: 0, active: true, isBgWeth: false, aeroFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
  { pool: '0x21594b992F68495dD28d605834b58889d0a727c7', token0: '0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b', token1: '0x4200000000000000000000000000000000000006', feeBps: 0, kind: 0, active: true, isBgWeth: false, aeroFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
  { pool: '0x7f670f78B17dEC44d5Ef68a48740b6f8849cc2e6', token0: '0x4200000000000000000000000000000000000006', token1: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', feeBps: 0, kind: 0, active: true, isBgWeth: false, aeroFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
  { pool: '0xAEC085E5A5CE8d96A7bDd3eB3A62445d4f6CE703', token0: '0x22aF33FE49fD1Fa80c7149773dDe5890D3c76F3b', token1: '0x4200000000000000000000000000000000000006', feeBps: 100, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x5116773e18A9C7bB03EBB961b38678E45E238923', token0: '0x3ec2156D4c0A9CBdAB4a016633b7BcF6a8d68Ea2', token1: '0x4200000000000000000000000000000000000006', feeBps: 100, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x566beE7EF7b39f29d150AB3be6b6242C17CC5A31', token0: '0x4200000000000000000000000000000000000006', token1: '0xFb31f85A8367210B2e4Ed2360D2dA9Dc2D2Ccc95', feeBps: 0, kind: 0, active: true, isBgWeth: false, aeroFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da' },
  { pool: '0xf79478d5a6baE4546F7e489e80b2fC690B558944', token0: '0x4200000000000000000000000000000000000006', token1: '0xB2000000000000000000004c27f6523082f41D01', feeBps: 100, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x7692AcC1CDd771D09EbCae3663e1843b2911BEC7', token0: '0x4200000000000000000000000000000000000006', token1: '0x5ab000ff9B9FfE0349CE5ffA5fD86f217C3680F5', feeBps: 100, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xEdc625B74537eE3a10874f53D170E9c17A906B9c', token0: '0x1111111111166b7FE7bd91427724B487980aFc69', token1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', feeBps: 30, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xE47F7dbA68a00dc1A6f11458BcDFcA810E1CFEbF', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xAb6363dA0C80cEF3Ae105Bd6241E30872355d021', feeBps: 30, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb20000000000000000000078ee7ce2fE4908108C', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xB1987CAD1682841b4b641d50E520777eC5Ab5542', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb2000000000000000000002D0BA3164cc74f58B7', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb200000000000000000000C2e324d24d7eEcd1fb', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xEAF57753BC382E0324a1D43F72E7027705a2273E', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb2000000000000000000008bC8786B856E61707C', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb200000000000000000000d9192b6B456483C2E8', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xB200000000000000000000Ab99cFa739E253872B', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x5A8236f575471e7BfCA2C8462a200c28f737246E', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb200000000000000000000397293Cb8cda9a10c5', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb2000000000000000000007b9fcbd005511aCBd5', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x8b27f626ab668197000BC722A1012022CAeD10E2', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb2000000000000000000004884b426556b92883d', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB', token0: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', token1: '0xb2000000000000000000001e800a7f5189430cD0', feeBps: 5, kind: 1, active: true, isBgWeth: false, aeroFactory: '0x0000000000000000000000000000000000000000' },
  { pool: '0xB446dE498eBfca7596A44fdbADbA6ab2567a3fD9', token0: '0x36b712A629095234F2196BbB000D1b96C12Ce78e', token1: '0x4200000000000000000000000000000000000006', feeBps: 30, kind: 0, active: true, isBgWeth: true, aeroFactory: '0x0000000000000000000000000000000000000000' },
] satisfies V1PoolEntry[]).map((e) => Object.freeze(e)));

/**
 * Owner-controlled router state, read on Base on 2026-10-31 (head 53,344,633). The routers' owner can
 * change every one of these (both routers are owned by one EOA). The kit re-reads all of it at
 * startup AND before every swap and activation (guard/router-state.ts), and refuses on any
 * difference, so a change is reviewed (and the pins re-released) before any agent signs against it.
 */
export const ROUTER_STATE = Object.freeze({
  owner: '0x81340E733897342F527fAE0dfDe47689F112E000' as Address,
  v1: Object.freeze({
    hopPool: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as Address,
    onchainQuoter: '0x5616b91C4D9B691ABF940e881aCcaE54951f3dBF' as Address,
    v4Adapter: '0x83B28DF966BC4ce383296974265911235AFd03ca' as Address,
    feeCollector: '0x21d5e97aFDbd7F2127aE5482e3bD70ba4f32d114' as Address,
    feeBps: 15,
    /** keccak256 of getPools()'s ABI-encoded return: the 29-pool registry. */
    poolsHash: '0xd4c7f73139823c7b49274431780132070727346c4700e259e94111b5c81d75b0' as Hex,
    poolCount: 29,
  }),
  v2: Object.freeze({
    adapters: Object.freeze(['0x7fA1b43542D03b54791649d9c981a5Ddd2d801D2', '0xB4C9e14928Dd3CE20dA8468F792a6eaFA452c340', '0xF55e89d4182BDf639629D32F5186073d8959622C'] as Address[]),
    /** payStyleOf(adapterId) for ids 1..3. */
    payStyles: Object.freeze([0, 1, 0]),
    /**
     * Every hook ever allowed (HookAllowed events since the deploy block 53,098,455; allowing is
     * one-way). hookAllowed() is a mapping, so a hook allowed AFTER this release is not seen at
     * startup without a log scan; BG sells never use v2, and every route is held to the reference
     * floor, which bounds what any hook can take.
     */
    allowedHooks: Object.freeze(['0x535BF6b009b2eFeb3A640d01F654BBCcFFF38088', '0xd31bf2baB60a373Ee54C9388Af210eeE0D538088'] as Address[]),
  }),
});

/**
 * Storage slots of each token's balance and allowance mappings, used to simulate the reference
 * route from this wallet without an approval (eth_call state override). Verified at startup: an
 * override of the pinned slot must read back through balanceOf / allowance.
 */
export const TOKEN_SLOTS: Readonly<Record<string, { readonly balance: bigint; readonly allowance: bigint }>> = Object.freeze({
  [ADDR.bg.toLowerCase()]: { balance: 0n, allowance: 1n },
  [ADDR.usdc.toLowerCase()]: { balance: 9n, allowance: 10n },
  [ADDR.weth.toLowerCase()]: { balance: 3n, allowance: 4n },
});

/** Chainlink ETH/USD on Base updates at least every 1200 s (measured: 60 rounds, max gap 1232 s). */
export const ETH_USD_MAX_AGE_S = 1500;
/** After the sequencer comes back up, prices are not trusted for this long. */
export const SEQUENCER_GRACE_S = 3600;

/** The only selectors the kit will ever sign, per target. */
export const SELECTOR = Object.freeze({
  /** approve(address,uint256) */
  approve: '0x095ea7b3',
  /** v1 swapExactInPath(address,address,uint256,address[],(address,uint256,uint160)[],address[],uint256,address,uint256) */
  v1SwapExactInPath: '0xa80b96c9',
  /**
   * v1 swapExactTokensForTokens(uint256,uint256,address[],address,uint256): the UniV2-compatible
   * entry, which derives its legs ON CHAIN (so it cannot go stale on an entry hop). Found as a PUSH4
   * in v1's runtime bytecode (and absent from v2's) on 2026-10-31.
   */
  v1SwapExactTokensForTokens: '0x38ed1739',
  /** v2 swapExactIn((address,address,uint256,((uint16,address,address,address,uint256,uint16,uint256,bytes)[])[]),uint256,address,uint256) */
  v2SwapExactIn: '0xfbd703f9',
  /** v2 swapExactOut(<same plan>,uint256 maxIn,address,uint256) */
  v2SwapExactOut: '0x9bfb1e49',
  /** MineBurnEntry.activate() */
  activate: '0x0f15f4c0',
} as const satisfies Record<string, Hex>);

/** Selectors that are refused by NAME (so the refusal can say exactly what was attempted). */
export const NAMED_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x42842e0e': 'safeTransferFrom(address,address,uint256)',
  '0xb88d4fde': 'safeTransferFrom(address,address,uint256,bytes)',
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0xd505accf': 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  '0x39509351': 'increaseAllowance(address,uint256)',
  '0xd0e30db0': 'deposit()',
  '0x2e1a7d4d': 'withdraw(uint256)',
});

/** BG is 18 decimals; MineBurnEntry.BURN_AMOUNT() is exactly this. */
export const MINE_BURN_AMOUNT = 100_000_000_000_000_000n;

export interface TokenInfo { readonly symbol: 'USDC' | 'BG' | 'WETH' | 'ETH'; readonly address: Address; readonly decimals: number }

/** The token allowlist. A swap may only start and end at these, with BG on exactly one side. */
export const TOKENS: Readonly<Record<TokenInfo['symbol'], TokenInfo>> = Object.freeze({
  USDC: { symbol: 'USDC', address: ADDR.usdc, decimals: 6 },
  BG: { symbol: 'BG', address: ADDR.bg, decimals: 18 },
  WETH: { symbol: 'WETH', address: ADDR.weth, decimals: 18 },
  ETH: { symbol: 'ETH', address: ETH_SENTINEL, decimals: 18 },
});

export type RouterName = 'v1' | 'v2';
export const ROUTERS: Readonly<Record<RouterName, Address>> = Object.freeze({ v1: ADDR.routerV1, v2: ADDR.routerV2 });

/**
 * Approval spenders per token. An approval is exact and must name the router the very swap it
 * funds targets (or, for BG, MineBurnEntry with exactly 0.1 BG). BG is never approved to router v2:
 * BG is never sold through v2, and v2 pulls its input with transferFrom, so without that allowance a
 * BG-input v2 swap cannot move BG even if one were signed (the CDP policy mirrors this).
 */
export const APPROVAL_SPENDERS: Readonly<Record<string, readonly Address[]>> = Object.freeze({
  [ADDR.usdc.toLowerCase()]: [ADDR.routerV1, ADDR.routerV2],
  [ADDR.weth.toLowerCase()]: [ADDR.routerV1, ADDR.routerV2],
  [ADDR.bg.toLowerCase()]: [ADDR.routerV1, ADDR.mineBurnEntry],
});

/** The two origins the kit talks to. Fixed: a configurable origin would let a config edit redirect logins. */
export const DEX_ORIGIN = 'https://mineswap.org' as const;
/** mineswap.app 307-redirects to www; the war-auth challenge must name the host the request lands on. */
export const GAME_ORIGIN = 'https://www.mineswap.app' as const;
export const GAME_HOST = 'www.mineswap.app' as const;

/** /api/quote is limited to 30 requests per minute per IP by mineswap.org's middleware. */
export const QUOTE_RATE_LIMIT_PER_MINUTE = 30;

export const sameAddress = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
