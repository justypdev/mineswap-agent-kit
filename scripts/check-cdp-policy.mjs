#!/usr/bin/env node
// Owner-run: check the policy attached to the agent account with CDP's policy SIMULATOR. Nothing is
// signed or sent. Every legitimate operation the kit performs must come back "accept", and every
// hostile one "reject"; the script exits 1 on any mismatch.
//
//   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… node scripts/check-cdp-policy.mjs 0xYourAgentWallet
//
// Use the ADMIN key (the one allowed to manage policies), not the kit's key.
//
// THE FOUR SWAP "accept" CASES CANNOT BE FULLY CHECKED FROM AN UNFUNDED WALLET. Their rules carry a
// netUSDChange criterion, which CDP evaluates by simulating the real transaction from the agent
// wallet as it stands; the simulator takes no balance or allowance input (SDK 1.60
// SendEvmTransactionSimulationInput is { address, transaction, network }). Without the input token
// and its approval the swap reverts, and CDP answers 422 transaction_simulation_failed ("the real
// operation would fail closed"). Those cases print INCONCLUSIVE and do not count as mismatches; every
// other criterion of their rules is still exercised by the reject cases next to them. A 422 on a
// "reject" case is a pass: the real operation fails closed too.
import { encodeFunctionData, erc20Abi, getAddress, maxUint256, parseAbi, serializeTransaction } from 'viem';
import { createSiweMessage } from 'viem/siwe';

// Self-contained (no build needed). test/policy-template.test.ts proves these equal src/pins.ts and
// the kit's own message builders.
export const ADDR = Object.freeze({
  routerV1: '0x7f0f058c731b479A214dA459a1AC4CF98d568Bf0',
  routerV2: '0xE4cB28BcBA75899764cd8B5c52a51f20B29afEE9',
  bg: '0x36b712A629095234F2196BbB000D1b96C12Ce78e',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  weth: '0x4200000000000000000000000000000000000006',
  mineBurnEntry: '0xF121e113330A2ede61c81B8887b7092F03566037',
  goldMineNft: '0x4F8f97e10E2D89Bc118d6fdfe74d1C96A821E4e3',
});
const siwe = (wallet, statement, timestamp, nonce) => createSiweMessage({
  domain: 'www.mineswap.app', address: getAddress(wallet), statement, uri: 'https://www.mineswap.app', version: '1', chainId: 8453,
  nonce, issuedAt: new Date(timestamp), expirationTime: new Date(timestamp + 5 * 60 * 1000),
});
export const buildWarAuthMessage = ({ wallet, tokenId, timestamp, nonce }) => siwe(wallet, `Sign in to MineSwap to play your Gold Mine #${tokenId}. This is a free signature, not a transaction; it can't move your tokens or NFTs, and it expires in 5 minutes.`, timestamp, nonce);
/** The war-auth wording before 2026-11-02 (kits up to that date sign it; the policy accepts both). */
export const buildLegacyWarAuthMessage = ({ wallet, tokenId, timestamp, nonce }) => siwe(wallet, `BaseGold war session for goldmine #${tokenId} (stack -).`, timestamp, nonce);
export const buildSessionMessage = ({ wallet, action, timestamp, nonce }) => siwe(wallet, action === 'takeover'
  ? 'MineSwap play session for this device, replacing the session on any other device.'
  : 'MineSwap play session for this device.', timestamp, nonce);

const ATTACKER = '0x000000000000000000000000000000000000bEEF';
const tx = (to, data, value = 0n) => serializeTransaction({ chainId: 8453, type: 'eip1559', to, data, value, nonce: 0, gas: 500_000n, maxFeePerGas: 10_000_000n, maxPriorityFeePerGas: 1_000_000n });
const v1Abi = parseAbi([
  'function swapExactTokensForTokens(uint256,uint256,address[],address,uint256) payable returns (uint256[])',
  'function swapExactInPath(address,address,uint256,address[],(address,uint256,uint160)[],address[],uint256,address,uint256) payable returns (uint256)',
]);
const v2Abi = parseAbi([
  'struct Leg { uint16 adapterId; address pool; address tokenIn; address tokenOut; uint256 amountIn; uint16 shareBps; uint256 minOut; bytes extra; }',
  'struct Hop { Leg[] legs; }',
  'struct Plan { address tokenIn; address tokenOut; uint256 amountIn; Hop[] hops; }',
  'function swapExactIn(Plan plan, uint256 minOut, address recipient, uint256 deadline) payable returns (uint256)',
  'function swapExactOut(Plan plan, uint256 maxIn, address recipient, uint256 deadline) payable returns (uint256, uint256)',
]);
const nftAbi = parseAbi(['function setApprovalForAll(address,bool)', 'function safeTransferFrom(address,address,uint256)']);
const entryAbi = parseAbi(['function activate()']);

/** The cases, as pure data (unit-tested without CDP). */
export function buildPolicyCases(walletIn, nowMs = Date.now()) {
  const self = getAddress(walletIn);
  const dl = BigInt(Math.floor(nowMs / 1000) + 600);
  const plan = (to) => ({ tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountIn: 1_000_000n, hops: [{ legs: [{ adapterId: 1, pool: '0xB446dE498eBfca7596A44fdbADbA6ab2567a3fD9', tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountIn: 998_500n, shareBps: 0, minOut: 90_000_000_000_000_000n, extra: '0x' }] }] });
  const send = (name, expect, to, data, value, needsChainState = false) => ({ name, expect, needsChainState, request: { operation: 'sendEvmTransaction', address: self, network: 'base', transaction: tx(to, data, value) } });
  const bgPlan = { tokenIn: ADDR.bg, tokenOut: ADDR.usdc, amountIn: 100_000_000_000_000_000n, hops: [{ legs: [{ adapterId: 1, pool: '0xB446dE498eBfca7596A44fdbADbA6ab2567a3fD9', tokenIn: ADDR.bg, tokenOut: ADDR.weth, amountIn: 99_850_000_000_000_000n, shareBps: 0, minOut: 1n, extra: '0x' }] }] };
  const msg = (name, expect, message) => ({ name, expect, request: { operation: 'signEvmMessage', address: self, message } });
  return [
    send('approve 1 USDC to router v1', 'accept', ADDR.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.routerV1, 1_000_000n] })),
    send('approve 1 USDC to router v2', 'accept', ADDR.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.routerV2, 1_000_000n] })),
    send('approve 0.1 BG to MineBurnEntry', 'accept', ADDR.bg, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.mineBurnEntry, 100_000_000_000_000_000n] })),
    send('approve 0.001 WETH to router v1', 'accept', ADDR.weth, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.routerV1, 1_000_000_000_000_000n] })),
    send('v1 swapExactTokensForTokens USDC→BG to self', 'accept', ADDR.routerV1, encodeFunctionData({ abi: v1Abi, functionName: 'swapExactTokensForTokens', args: [1_000_000n, 90_000_000_000_000_000n, [ADDR.usdc, ADDR.weth, ADDR.bg], self, dl] }), 0n, true),
    send('v1 swapExactInPath ETH→BG to self', 'accept', ADDR.routerV1, encodeFunctionData({ abi: v1Abi, functionName: 'swapExactInPath', args: ['0x0000000000000000000000000000000000000000', ADDR.bg, 100_000_000_000_000n, [], [['0xB446dE498eBfca7596A44fdbADbA6ab2567a3fD9', 99_850_000_000_000n, 0n]], [], 1n, self, dl] }), 100_000_000_000_000n, true),
    send('v2 swapExactIn USDC→BG to self', 'accept', ADDR.routerV2, encodeFunctionData({ abi: v2Abi, functionName: 'swapExactIn', args: [plan(), 90_000_000_000_000_000n, self, dl] }), 0n, true),
    send('v2 swapExactOut USDC→BG to self', 'accept', ADDR.routerV2, encodeFunctionData({ abi: v2Abi, functionName: 'swapExactOut', args: [plan(), 1_010_000n, self, dl] }), 0n, true),
    send('MineBurnEntry.activate()', 'accept', ADDR.mineBurnEntry, encodeFunctionData({ abi: entryAbi, functionName: 'activate' })),
    msg('war-auth sign-in for this wallet', 'accept', buildWarAuthMessage({ wallet: self, tokenId: 70, timestamp: nowMs, nonce: 'policyCheck123' })),
    msg('war-auth sign-in for this wallet (pre-2026-11-02 wording, older kits)', 'accept', buildLegacyWarAuthMessage({ wallet: self, tokenId: 70, timestamp: nowMs, nonce: 'policyCheck123' })),
    msg('play session (create) for this wallet', 'accept', buildSessionMessage({ wallet: self, action: 'create', timestamp: nowMs, nonce: 'policyCheck123' })),
    msg('play session (takeover) for this wallet', 'accept', buildSessionMessage({ wallet: self, action: 'takeover', timestamp: nowMs, nonce: 'policyCheck123' })),
    send('USDC transfer to an attacker', 'reject', ADDR.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ATTACKER, 1n] })),
    send('USDC approval to an attacker', 'reject', ADDR.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ATTACKER, 1n] })),
    send('unlimited BG approval to router v1', 'reject', ADDR.bg, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.routerV1, maxUint256] })),
    send('v1 swap paying an attacker', 'reject', ADDR.routerV1, encodeFunctionData({ abi: v1Abi, functionName: 'swapExactTokensForTokens', args: [1_000_000n, 1n, [ADDR.usdc, ADDR.weth, ADDR.bg], ATTACKER, dl] })),
    send('v2 swap paying an attacker', 'reject', ADDR.routerV2, encodeFunctionData({ abi: v2Abi, functionName: 'swapExactIn', args: [plan(), 1n, ATTACKER, dl] })),
    send('setApprovalForAll on the Mine NFT', 'reject', ADDR.goldMineNft, encodeFunctionData({ abi: nftAbi, functionName: 'setApprovalForAll', args: [ATTACKER, true] })),
    send('plain ETH send to an attacker', 'reject', ATTACKER, '0x', 1n),
    { name: 'signEvmTransaction (sign without sending)', expect: 'reject', request: { operation: 'signEvmTransaction', address: self, transaction: tx(ADDR.usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.routerV1, 1n] })) } },
    msg('an arbitrary message', 'reject', 'Please sign to claim your airdrop'),
    msg('war-auth sign-in naming another wallet', 'reject', buildWarAuthMessage({ wallet: ATTACKER, tokenId: 70, timestamp: nowMs, nonce: 'policyCheck123' })),
    msg('war-auth sign-in naming another wallet (pre-2026-11-02 wording)', 'reject', buildLegacyWarAuthMessage({ wallet: ATTACKER, tokenId: 70, timestamp: nowMs, nonce: 'policyCheck123' })),
    { name: 'EIP-2612 permit (typed data)', expect: 'reject', request: { operation: 'signEvmTypedData', address: self, domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: ADDR.usdc }, types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, primaryType: 'Permit', message: { owner: self, spender: ATTACKER, value: '1', nonce: '0', deadline: '9999999999' } } },
    { name: 'raw hash signature', expect: 'reject', request: { operation: 'signEvmHash', address: self, hash: `0x${'ab'.repeat(32)}` } },
    send('approve 0.1 BG to router v2 (BG is never sold through v2)', 'reject', ADDR.bg, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ADDR.routerV2, 100_000_000_000_000_000n] })),
    // CDP's evmData criterion reads only top-level primitive arguments, and v2's tokenIn sits inside
    // the `plan` tuple, so no rule can name it. This swap is refused because BG can never be approved
    // to v2 (rule above) and v2 pulls its input with transferFrom: CDP cannot simulate it (422).
    send('v2 swapExactIn selling BG (no BG allowance to v2 can exist)', 'reject', ADDR.routerV2, encodeFunctionData({ abi: v2Abi, functionName: 'swapExactIn', args: [bgPlan, 1n, self, dl] }), 0n, true),
    { name: 'user operation (prepareUserOperation) moving USDC out', expect: 'reject', request: { operation: 'prepareUserOperation', address: self, network: 'base', calls: [{ to: ADDR.usdc, value: '0', data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ATTACKER, 1n] }) }] } },
  ];
}

/** CDP's answer for one case: accept, reject, fail-closed (422), n/a (404 user operation), or error. */
export async function simulateCase(cdp, c) {
  try {
    return (await cdp.policies.simulate(c.request)).action;
  } catch (e) {
    if (e?.statusCode === 422) return 'fail-closed';
    if (e?.statusCode === 404 && c.request.operation === 'prepareUserOperation') return 'n/a';
    const t = typeof e?.errorType === 'string' && /^[a-z_]{1,60}$/.test(e.errorType) ? e.errorType : (e?.name ?? 'Error');
    return `error (${e?.statusCode ?? '-'} ${t})`;
  }
}

/**
 * ok | FAIL | INCONCLUSIVE. A reject case passes on reject or fail-closed (the real operation fails
 * closed too); a user-operation case also on n/a (the account is not a smart account, so CDP cannot run
 * user operations for it at all). An accept case passes only on accept; a swap accept that CDP could
 * not simulate from the wallet's current state is INCONCLUSIVE, not a pass.
 */
export function verdict(c, got) {
  if (c.expect === 'reject') return got === 'reject' || got === 'fail-closed' || (got === 'n/a' && c.request.operation === 'prepareUserOperation') ? 'ok' : 'FAIL';
  if (got === 'accept') return 'ok';
  return got === 'fail-closed' && c.needsChainState ? 'INCONCLUSIVE' : 'FAIL';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wallet = process.argv[2];
  if (!wallet) { console.error('usage: node scripts/check-cdp-policy.mjs 0xAgentWallet'); process.exit(2); }
  const { CdpClient } = await import('@coinbase/cdp-sdk');
  const cdp = new CdpClient();
  let bad = 0;
  let inconclusive = 0;
  for (const c of buildPolicyCases(wallet)) {
    const got = await simulateCase(cdp, c);
    const v = verdict(c, got);
    if (v === 'FAIL') bad++;
    if (v === 'INCONCLUSIVE') inconclusive++;
    console.log(`${v.padEnd(12)} ${c.name}: expected ${c.expect}, got ${got}`);
  }
  if (inconclusive) console.log(`${inconclusive} swap case(s) INCONCLUSIVE: CDP could not simulate them from this wallet's current state (see the note at the top of this script)`);
  console.log(bad ? `${bad} mismatch(es): the policy does not do what the kit expects` : 'no mismatches');
  process.exit(bad ? 1 : 0);
}
