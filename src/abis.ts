/**
 * The minimal ABIs the kit decodes and calls. The router fragments match the routers' verified
 * deployed interfaces on Base, and their selectors are pinned against pins.ts SELECTOR in the tests
 * (and were found in each router's runtime bytecode).
 */
export const ERC20_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const;

const V1_LEG = {
  name: 'legs',
  type: 'tuple[]',
  components: [
    { name: 'pool', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'sqrtPriceLimitX96', type: 'uint160' },
  ],
} as const;

export const ROUTER_V1_ABI = [
  {
    type: 'function',
    name: 'swapExactInPath',
    stateMutability: 'payable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'hopIn', type: 'address[]' },
      V1_LEG,
      { name: 'hopOut', type: 'address[]' },
      { name: 'minTotalOut', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'swapExactTokensForTokens',
    stateMutability: 'payable',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'amountOutMin', type: 'uint256' },
      { name: 'path', type: 'address[]' },
      { name: 'to', type: 'address' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }],
  },
] as const;

const V2_PLAN = {
  name: 'plan',
  type: 'tuple',
  components: [
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    {
      name: 'hops',
      type: 'tuple[]',
      components: [
        {
          name: 'legs',
          type: 'tuple[]',
          components: [
            { name: 'adapterId', type: 'uint16' },
            { name: 'pool', type: 'address' },
            { name: 'tokenIn', type: 'address' },
            { name: 'tokenOut', type: 'address' },
            { name: 'amountIn', type: 'uint256' },
            { name: 'shareBps', type: 'uint16' },
            { name: 'minOut', type: 'uint256' },
            { name: 'extra', type: 'bytes' },
          ],
        },
      ],
    },
  ],
} as const;

export const ROUTER_V2_ABI = [
  {
    type: 'function',
    name: 'swapExactIn',
    stateMutability: 'payable',
    inputs: [V2_PLAN, { name: 'minOut', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'swapExactOut',
    stateMutability: 'payable',
    inputs: [V2_PLAN, { name: 'maxIn', type: 'uint256' }, { name: 'recipient', type: 'address' }, { name: 'deadline', type: 'uint256' }],
    outputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOut', type: 'uint256' }],
  },
  { type: 'function', name: 'BG', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'USDC', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'WETH', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'FEE_BPS', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint16' }] },
] as const;

export const MINE_BURN_ENTRY_ABI = [
  { type: 'function', name: 'activate', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'bg', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'nft', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'BURN_AMOUNT', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
] as const;

export const GOLD_MINE_NFT_ABI = [
  { type: 'function', name: 'hasMine', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'getMineIdByAddress', stateMutability: 'view', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'goldVein', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ name: 'tokenId', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
] as const;

export const CHAINLINK_ABI = [
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

const view = (name: string, inputs: readonly { name: string; type: string }[], outputs: readonly { name: string; type: string }[]) =>
  ({ type: 'function', name, stateMutability: 'view', inputs, outputs }) as const;

/** v1 owner-controlled state, checked at startup and before every swap against pins.ts. */
export const ROUTER_V1_STATE_ABI = [
  view('owner', [], [{ name: '', type: 'address' }]),
  view('pendingOwner', [], [{ name: '', type: 'address' }]),
  view('hopPool', [], [{ name: '', type: 'address' }]),
  view('onchainQuoter', [], [{ name: '', type: 'address' }]),
  view('v4Adapter', [], [{ name: '', type: 'address' }]),
  view('feeCollector', [], [{ name: '', type: 'address' }]),
  view('feeBps', [], [{ name: '', type: 'uint16' }]),
  view('getPools', [], [{ name: '', type: 'address[]' }]),
  view('paused', [], [{ name: '', type: 'bool' }]),
  {
    type: 'function', name: 'getPoolInfo', stateMutability: 'view', inputs: [{ name: 'pool', type: 'address' }],
    outputs: [{ name: '', type: 'tuple', components: [
      { name: 'token0', type: 'address' }, { name: 'feeBps', type: 'uint16' }, { name: 'kind', type: 'uint8' },
      { name: 'active', type: 'bool' }, { name: 'isBgWeth', type: 'bool' }, { name: 'token1', type: 'address' },
    ] }],
  },
  view('aeroFactoryOf', [{ name: 'pool', type: 'address' }], [{ name: '', type: 'address' }]),
] as const;

/** v2 owner-controlled state, checked at startup and before every swap against pins.ts. */
export const ROUTER_V2_STATE_ABI = [
  view('owner', [], [{ name: '', type: 'address' }]),
  view('pendingOwner', [], [{ name: '', type: 'address' }]),
  view('adapterCount', [], [{ name: '', type: 'uint16' }]),
  view('adapters', [], [{ name: '', type: 'address[]' }]),
  view('payStyleOf', [{ name: 'adapterId', type: 'uint16' }], [{ name: '', type: 'uint8' }]),
  view('hookAllowed', [{ name: 'hook', type: 'address' }], [{ name: '', type: 'bool' }]),
] as const;
