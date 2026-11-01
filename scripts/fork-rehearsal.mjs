#!/usr/bin/env node
// Fork rehearsal: the kit's REAL buy_bg and activate_mine, called as MCP tools, against the REAL
// router (v1 or v2, whichever mineswap.org's quote targets), BG and MineBurnEntry on an anvil fork
// of Base, from a FRESH key. Needs anvil (Foundry) on PATH and a Base archive RPC.
//
//   npm run build
//   FORK_RPC_URL_FILE=/path/to/file-holding-the-rpc-url node scripts/fork-rehearsal.mjs <out-dir>
//   (or FORK_RPC_URL=https://…; the file form keeps a keyed URL out of the process environment)
//
// Run it somewhere isolated: it starts anvil, impersonates a USDC holder on the fork and writes a
// throwaway key under <out-dir> (deleted at the end).
//
// Quote: a LIVE quote is taken from https://mineswap.org/api/quote for the fresh wallet (USDC→BG,
// exact-out 0.1 BG, slippage 75 bps = 3/4 of the kit's 100 bps cap, as the kit asks), recorded to
// <out-dir>/quote.json, and the fork is pinned to the quote's own block; the kit's dex client is then
// served that recorded response (replay), so the calldata the guard checks is byte-for-byte what the
// live API returned.
//
// The RPC URL is never printed or put on a command line: anvil forks through a 127.0.0.1 proxy that
// holds it. Traps honoured: a fresh key (never anvil's default accounts #0/#1, which carry EIP-7702
// sweeper code on Base), anvil with default flags.
//
// HOP MOVE (default on; REHEARSAL_MOVE_HOP=0 turns it off): after the quote is recorded and before
// the kit runs, a second fresh key sells WETH into the USDC/WETH hop pool through Uniswap's
// SwapRouter02, so the hop's output no longer matches the quote. The rehearsal shows the quote's
// own v1 swapExactInPath calldata succeeding before the move and reverting after it, and the kit's
// buy_bg still buying 0.1 BG and minting a mine (v1 swapExactTokensForTokens, legs derived on chain).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const OUT = resolve(process.argv[2] ?? './.rehearsal');
mkdirSync(OUT, { recursive: true, mode: 0o700 });
const ANVIL_PORT = Number(process.env.REHEARSAL_ANVIL_PORT ?? 8617);
const PROXY_PORT = Number(process.env.REHEARSAL_PROXY_PORT ?? 8618);
const RED = /https?:\/\/[^\s"']+/g;
const log = (m) => process.stdout.write(`[rehearsal] ${String(m).replace(RED, (u) => (u.startsWith('http://127.0.0.1') || u.startsWith('https://mineswap.org') ? u : '<redacted>'))}\n`);

const ADDR = {
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  bg: '0x36b712A629095234F2196BbB000D1b96C12Ce78e',
  entry: '0xF121e113330A2ede61c81B8887b7092F03566037',
  nft: '0x4F8f97e10E2D89Bc118d6fdfe74d1C96A821E4e3',
  routerV1: '0x7f0f058c731b479A214dA459a1AC4CF98d568Bf0',
  routerV2: '0xE4cB28BcBA75899764cd8B5c52a51f20B29afEE9',
};
// USDC holders (plain EOAs at block 53,332,249) to impersonate for funding; the first with ≥ 5 USDC is used.
const USDC_HOLDERS = ['0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A', '0x20FE51A9229EEf2cF8Ad9E89d91CAb9312cF3b7A'];
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function transfer(address,uint256) returns (bool)']);
const NFT = parseAbi(['function hasMine(address) view returns (bool)', 'function getMineIdByAddress(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)']);

const children = [];
let proxy;
function cleanup() {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* gone */ } }
  try { proxy?.close(); } catch { /* closed */ }
}
process.on('exit', cleanup);
const assert = (cond, msg) => { if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`); log(`ok  ${msg}`); };

async function main() {
  const upstream = process.env.FORK_RPC_URL_FILE ? readFileSync(process.env.FORK_RPC_URL_FILE, 'utf8').trim() : (process.env.FORK_RPC_URL ?? '').trim();
  if (!/^https?:\/\//.test(upstream)) throw new Error('set FORK_RPC_URL_FILE (a file holding a Base RPC URL) or FORK_RPC_URL');

  // 1. A loopback proxy that holds the keyed URL, so anvil's argv never carries it.
  proxy = createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    try {
      const r = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch {
      res.writeHead(502); res.end('{"jsonrpc":"2.0","error":{"code":-32000,"message":"upstream failed"}}');
    }
  });
  await new Promise((ok) => proxy.listen(PROXY_PORT, '127.0.0.1', ok));

  // 2. A fresh key, written 0600 for the kit's local test signer.
  const key = generatePrivateKey();
  const self = privateKeyToAccount(key).address;
  const keyFile = join(OUT, 'fresh.key');
  writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
  log(`fresh wallet ${self}`);

  // 3. A LIVE quote from mineswap.org for this wallet; record it; fork at its block.
  const q = new URL('https://mineswap.org/api/quote');
  for (const [k, v] of Object.entries({ tokenIn: ADDR.usdc, tokenOut: ADDR.bg, amountOut: '100000000000000000', slippageBps: '75', recipient: self })) q.searchParams.set(k, v);
  const live = await fetch(q, { redirect: 'error' });
  const quoteText = await live.text();
  writeFileSync(join(OUT, 'quote.json'), quoteText);
  const quote = JSON.parse(quoteText);
  assert(live.status === 200 && quote.ok === true && quote.executable === true, `live quote ok (HTTP ${live.status}, block ${quote.blockNumber}, router ${quote.router ?? 'v1'}, to ${quote.calldata?.to})`);
  const forkBlock = Number(quote.blockNumber);

  // 4. anvil, default flags, forked at the quote's block through the proxy.
  const anvil = spawn('anvil', ['--fork-url', `http://127.0.0.1:${PROXY_PORT}`, '--fork-block-number', String(forkBlock), '--port', String(ANVIL_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(anvil);
  const anvilLog = [];
  anvil.stdout.on('data', (d) => anvilLog.push(String(d)));
  anvil.stderr.on('data', (d) => anvilLog.push(String(d)));
  const rpc = `http://127.0.0.1:${ANVIL_PORT}`;
  const raw = async (method, params = []) => {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  for (let i = 0; ; i++) {
    try { await raw('eth_chainId'); break; } catch { if (i > 120) throw new Error('anvil did not start'); await new Promise((r) => setTimeout(r, 500)); }
  }
  const client = createPublicClient({ chain: base, transport: http(rpc) });
  assert((await client.getChainId()) === 8453, `anvil fork of Base at block ${forkBlock}`);

  // 5. Fund: ETH by anvil_setBalance; USDC from an impersonated holder.
  await raw('anvil_setBalance', [self, '0x2386F26FC10000']); // 0.01 ETH
  let holder = null;
  for (const h of USDC_HOLDERS) {
    if ((await client.readContract({ address: ADDR.usdc, abi: ERC20, functionName: 'balanceOf', args: [h] })) >= 5_000_000n && (await client.getCode({ address: h })) === undefined) { holder = h; break; }
  }
  assert(holder !== null, `a plain-EOA USDC holder to impersonate (${holder})`);
  await raw('anvil_setBalance', [holder, '0xDE0B6B3A7640000']);
  await raw('anvil_impersonateAccount', [holder]);
  const fundHash = await raw('eth_sendTransaction', [{ from: holder, to: ADDR.usdc, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [self, 5_000_000n] }) }]);
  await client.waitForTransactionReceipt({ hash: fundHash });
  await raw('anvil_stopImpersonatingAccount', [holder]);
  const usdc0 = await client.readContract({ address: ADDR.usdc, abi: ERC20, functionName: 'balanceOf', args: [self] });
  assert(usdc0 === 5_000_000n, 'fresh wallet holds 5 USDC and 0.01 ETH');

  // 5b. Move the hop pool, proving the quote's own entry-hop calldata goes stale.
  const MOVE = process.env.REHEARSAL_MOVE_HOP !== '0';
  const staleProne = quote.calldata.to.toLowerCase() === ADDR.routerV1.toLowerCase() && quote.calldata.data.startsWith('0xa80b96c9');
  let hopMove = null;
  if (MOVE) {
    const POOL = '0xd0b53D9277642d899DF5C87A3966A349A798F224';
    const SWAP_ROUTER_02 = '0x2626664c2603336E57B271c5C0b26F421741e481';
    const SLOT0 = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)']);
    const quoteCall = async () => {
      try { await raw('eth_call', [{ from: holder, to: ADDR.routerV1, data: quote.calldata.data }, 'latest']); return 'ok'; }
      catch (e) { return `reverted: ${String(e.message).slice(0, 160)}`; }
    };
    if (staleProne) {
      // Let the (impersonated) holder approve the router for the quote's input, so the quote's own
      // calldata can be simulated from it before and after the move.
      await raw('anvil_impersonateAccount', [holder]);
      const apHash = await raw('eth_sendTransaction', [{ from: holder, to: ADDR.usdc, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [ADDR.routerV1, BigInt(quote.amountIn)] }) }]);
      await client.waitForTransactionReceipt({ hash: apHash });
      const before = await quoteCall();
      assert(before === 'ok', `before the move, the quote's own v1 swapExactInPath calldata simulates fine (${before})`);
    }
    const [sqrtBefore] = await client.readContract({ address: POOL, abi: SLOT0, functionName: 'slot0' });
    const mover = privateKeyToAccount(generatePrivateKey());
    await raw('anvil_setBalance', [mover.address, '0x8AC7230489E80000']); // 10 ETH
    const mw = createWalletClient({ account: mover, chain: base, transport: http(rpc) });
    const WETH = '0x4200000000000000000000000000000000000006';
    const amt = 5n * 10n ** 18n;
    for (const req of [
      { address: WETH, abi: parseAbi(['function deposit() payable']), functionName: 'deposit', value: amt },
      { address: WETH, abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [SWAP_ROUTER_02, amt] },
      { address: SWAP_ROUTER_02, abi: parseAbi(['function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)']), functionName: 'exactInputSingle', args: [{ tokenIn: WETH, tokenOut: ADDR.usdc, fee: 500, recipient: mover.address, amountIn: amt, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] },
    ]) {
      const h = await mw.writeContract({ ...req, chain: base });
      const rcpt = await client.waitForTransactionReceipt({ hash: h });
      if (rcpt.status !== 'success') throw new Error(`hop move step ${req.functionName} reverted`);
    }
    const [sqrtAfter] = await client.readContract({ address: POOL, abi: SLOT0, functionName: 'slot0' });
    assert(sqrtAfter !== sqrtBefore, `hop pool moved: sold 5 WETH into USDC/WETH 0.05% (sqrtPriceX96 ${sqrtBefore} → ${sqrtAfter})`);
    hopMove = { soldWeth: '5', sqrtPriceBefore: String(sqrtBefore), sqrtPriceAfter: String(sqrtAfter) };
    if (staleProne) {
      const after = await quoteCall();
      assert(after.startsWith('reverted'), `after the move, the quote's own v1 swapExactInPath calldata reverts (${after})`);
      hopMove.quoteCalldataAfterMove = after;
      await raw('anvil_stopImpersonatingAccount', [holder]);
    }
  }

  // 6. The kit, exactly as the MCP server builds it, with the recorded quote replayed.
  const kitLib = await import(new URL('../dist/index.js', import.meta.url).href);
  const { createMcpServer } = kitLib;
  // Fees: anvil with default flags answers eth_maxPriorityFeePerGas with 1 gwei, so its fee estimate
  // (~1 gwei) is far above Base's real one (~0.007 gwei) and above the kit's 0.5 gwei default cap.
  // The rehearsal first shows that default cap refusing (nothing signed), then raises the cap to 2 gwei
  // in its own config, as an owner would, to run the flow.
  const forkFees = await client.estimateFeesPerGas();
  log(`fork fee estimate: maxFeePerGas ${forkFees.maxFeePerGas} wei, priority ${forkFees.maxPriorityFeePerGas} wei (anvil default)`);
  const FEE_CAP_GWEI = 2;
  const configFor = (dir, limits) => kitLib.resolveConfig({
    rpcUrl: rpc,
    signer: { type: 'local-test', keyFile, acknowledgeTestOnly: true },
    limits: { maxSlippageBps: 100, maxTxUsd: 5, maxDailyUsd: 10, ...limits },
    ledgerPath: join(OUT, dir, 'ledger', 'spend-ledger.json'),
    ledgerSentinelPath: join(OUT, dir, 'sentinel', 'spend-ledger.sentinel'),
  });
  const config = configFor('kit', { maxFeePerGasGwei: FEE_CAP_GWEI });
  // This script is a test harness: it replays the recorded quote through createKit's fetch override.
  process.env.MINESWAP_AGENT_KIT_TEST_OVERRIDES = '1';
  const replay = async (url) => {
    const u = new URL(url);
    if (u.origin !== 'https://mineswap.org' || u.pathname !== '/api/quote') throw new Error(`rehearsal: unexpected request to ${u.origin}${u.pathname}`);
    for (const k of ['tokenIn', 'tokenOut', 'amountOut', 'slippageBps', 'recipient']) {
      if (u.searchParams.get(k) !== q.searchParams.get(k)) throw new Error(`rehearsal: the kit asked a different quote (${k}=${u.searchParams.get(k)})`);
    }
    return new Response(quoteText, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  {
    const nonce0 = await client.getTransactionCount({ address: self });
    const capped = await kitLib.createKit(configFor('default-cap', {}), { fetch: replay, log });
    const srv = createMcpServer(capped);
    const [x, y] = InMemoryTransport.createLinkedPair();
    const probe = new Client({ name: 'fork-rehearsal-feecap', version: '1.0.0' });
    await Promise.all([srv.connect(x), probe.connect(y)]);
    const r = await probe.callTool({ name: 'buy_bg', arguments: { bgAmount: '0.1' } });
    assert(r.isError && /FEE_CAP_EXCEEDED/.test(r.content[0].text), `the kit's DEFAULT 0.5 gwei fee cap refuses anvil's ${forkFees.maxFeePerGas} wei fee (FEE_CAP_EXCEEDED)`);
    assert((await client.getTransactionCount({ address: self })) === nonce0, 'nothing was signed or sent under the refused fee');
  }
  const kit = await kitLib.createKit(config, { fetch: replay, log });
  assert(kit.wallet.address === getAddress(self), 'kit wallet = the fresh key');
  assert(kit.wallet.pinReport.checks.every((c) => c.ok), `kit startup pin verification passed on the fork (${kit.wallet.pinReport.checks.length} checks)`);

  const server = createMcpServer(kit);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: 'fork-rehearsal', version: '1.0.0' });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content?.[0]?.text ?? '';
    writeFileSync(join(OUT, `${name}.result.txt`), text);
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return JSON.parse(text);
  };

  // 7. buy_bg (the real tool) against the real router.
  const bg0 = await client.readContract({ address: ADDR.bg, abi: ERC20, functionName: 'balanceOf', args: [self] });
  const buy = await call('buy_bg', { bgAmount: '0.1' });
  log(`buy_bg: router ${buy.router} ${buy.routerAddress} ${buy.fn} (dispatch ${buy.dispatch}, floor tightened ${buy.tightened}), spend ${buy.spend} USDC units (${buy.spendUsd}), minOut ${buy.minOut}, simulated ${buy.simulatedOut}, reference ${buy.referenceOut}, received ${buy.receivedOut}`);
  const swapTx = await client.getTransaction({ hash: buy.swapHash });
  assert(buy.approveHash, 'the buy sent its own exact approval');
  const approveTx = await client.getTransaction({ hash: buy.approveHash });
  for (const [n, t] of [['approve', approveTx], ['swap', swapTx]]) {
    assert(t.gas > 21_000n && t.gas <= config.limits.maxGasPerTx && t.maxFeePerGas > 0n && t.maxFeePerGas <= config.limits.maxFeePerGasWei,
      `the ${n} carried the kit's own capped terms (gas ${t.gas} ≤ ${config.limits.maxGasPerTx}, maxFeePerGas ${t.maxFeePerGas} ≤ ${config.limits.maxFeePerGasWei})`);
  }
  if (buy.router === 'v1') {
    assert(swapTx.input.startsWith('0x38ed1739') && buy.fn === 'swapExactTokensForTokens', 'the v1 swap the kit sent is swapExactTokensForTokens (0x38ed1739), legs derived on chain');
  }
  const bg1 = await client.readContract({ address: ADDR.bg, abi: ERC20, functionName: 'balanceOf', args: [self] });
  assert(buy.routerAddress === getAddress(quote.calldata.to), 'the swap went to the router the live quote targeted');
  assert(bg1 - bg0 >= BigInt(buy.minOut), 'received at least the swap\'s own floor');
  assert([ADDR.routerV1, ADDR.routerV2].includes(buy.routerAddress), 'that router is one of the two pinned routers');
  assert(bg1 - bg0 >= 100_000_000_000_000_000n, `received ≥ 0.1 BG (${bg1 - bg0} wei)`);
  assert((await client.readContract({ address: ADDR.usdc, abi: ERC20, functionName: 'allowance', args: [self, buy.routerAddress] })) === 0n, 'no USDC allowance left on the router');

  // 8. activate_mine (the real tool) against the real MineBurnEntry.
  const supply0 = await client.readContract({ address: ADDR.bg, abi: ERC20, functionName: 'totalSupply' });
  const act = await call('activate_mine');
  const bg2 = await client.readContract({ address: ADDR.bg, abi: ERC20, functionName: 'balanceOf', args: [self] });
  const supply1 = await client.readContract({ address: ADDR.bg, abi: ERC20, functionName: 'totalSupply' });
  const mineId = await client.readContract({ address: ADDR.nft, abi: NFT, functionName: 'getMineIdByAddress', args: [self] });
  assert(await client.readContract({ address: ADDR.nft, abi: NFT, functionName: 'hasMine', args: [self] }), 'nft.hasMine(fresh wallet) = true');
  assert(BigInt(act.mineId) === mineId && mineId > 0n, `mine minted: Gold Mine #${mineId}`);
  assert(getAddress(await client.readContract({ address: ADDR.nft, abi: NFT, functionName: 'ownerOf', args: [mineId] })) === getAddress(self), 'ownerOf(mine) = fresh wallet');
  assert(bg1 - bg2 === 100_000_000_000_000_000n, 'exactly 0.1 BG left the wallet');
  assert(supply0 - supply1 === 100_000_000_000_000_000n, 'exactly 0.1 BG burned from totalSupply');
  assert((await client.readContract({ address: ADDR.bg, abi: ERC20, functionName: 'allowance', args: [self, ADDR.entry] })) === 0n, 'no BG allowance left on MineBurnEntry');

  // 9. The guards on the fork: a second activation and a figures check are refused, nothing signed.
  const again = await mcp.callTool({ name: 'activate_mine', arguments: {} });
  assert(again.isError && /ALREADY_HAS_MINE/.test(again.content[0].text), 'a second activate_mine is refused (ALREADY_HAS_MINE)');
  const status = await call('wallet_status');
  assert(status.goldMine === Number(mineId) && status.limits.spentLast24hUsd === buy.spendUsd, `wallet_status: mine #${status.goldMine}, spent in the last 24 h ${status.limits.spentLast24hUsd}`);

  const summary = {
    result: 'PASS', forkBlock, wallet: self, quoteMode: 'live quote recorded at the fork block, replayed to the kit',
    router: buy.router, routerAddress: buy.routerAddress, fn: buy.fn, dispatch: buy.dispatch, tightened: buy.tightened, hopMove,
    quoteCalldataSelector: quote.calldata.data.slice(0, 10), sentSelector: swapTx.input.slice(0, 10),
    approveHash: buy.approveHash, swapHash: buy.swapHash,
    spendUsdcUnits: String(buy.spend), receivedBgWei: String(bg1 - bg0), activateHash: act.activateHash, mineId: Number(mineId),
  };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  log(`SUMMARY ${JSON.stringify(summary)}`);
  await mcp.close?.();
}

main().then(() => { cleanup(); rmSync(join(OUT, 'fresh.key'), { force: true }); process.exit(0); }, (e) => {
  log(`FAIL ${e?.stack ?? e}`);
  cleanup();
  rmSync(join(OUT, 'fresh.key'), { force: true });
  process.exit(1);
});
