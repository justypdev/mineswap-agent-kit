/**
 * The MCP surface (stdio). Every tool is a thin call into the library; nothing here signs or
 * builds calldata. Tool arguments are validated by schema and then treated as REQUESTS: the guard
 * decides what may be signed, from its pins and the chain.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { formatUnits } from 'viem';
import { z } from 'zod';
import { QuoteRefused, buyBg, parseAmount, previewSwap, requestSlippageBps, swap, tokenBySymbol } from '../dex.js';
import { HttpError, RateLimitedError } from '../http.js';
import { EXPEDITION_TYPES, GameApiError, UPGRADE_IDS } from '../game.js';
import { centsToUsd } from '../guard/policy.js';
import { isKitIncident } from '../guard/incident.js';
import { isGuardRefusal } from '../guard/refusal.js';
import type { Kit } from '../kit.js';
import { ADDR } from '../pins.js';

export const KIT_VERSION = '0.1.0';

const TOKEN = z.enum(['USDC', 'BG', 'WETH', 'ETH']);
const AMOUNT = z.string().regex(/^\d{1,30}(\.\d{1,30})?$/, 'a plain decimal number such as "1.5"');

export const TOOL_SCHEMAS = {
  wallet_status: z.object({}),
  quote: z.object({
    tokenIn: TOKEN, tokenOut: TOKEN,
    amountIn: AMOUNT.optional().describe('exact input, decimal'),
    amountOut: AMOUNT.optional().describe('target output, decimal (solves for the input)'),
  }),
  buy_bg: z.object({
    bgAmount: AMOUNT.default('0.1').describe('BG to buy; at least this much arrives. 0.1 BG activates one mine.'),
    maxUsdc: AMOUNT.optional().describe('refuse if the swap would spend more USDC than this'),
  }),
  swap: z.object({
    tokenIn: TOKEN, tokenOut: TOKEN,
    amountIn: AMOUNT.describe('exact input, decimal'),
    minAmountOut: AMOUNT.optional().describe('refuse unless at least this much output is guaranteed'),
  }),
  activate_mine: z.object({}),
  login: z.object({}),
  state: z.object({ includeSmelter: z.boolean().default(false) }),
  mine: z.object({ clicks: z.number().int().min(1).max(10_000) }),
  upgrade: z.object({ upgradeId: z.enum(UPGRADE_IDS), count: z.number().int().min(1).max(10).default(1) }),
  expedition: z.object({ action: z.enum(['start', 'claim', 'status']), type: z.enum(EXPEDITION_TYPES).optional() }),
  claim: z.object({ action: z.enum(['status', 'claim', 'history']).default('status'), batchId: z.string().min(1).max(200).optional() }),
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;

const DESCRIPTIONS: Record<ToolName, string> = {
  wallet_status: 'Read-only. The agent wallet address, its ETH/USDC/BG balances, whether it owns a Gold Mine, the spend caps and what was spent in the last 24 hours.',
  quote: 'Read-only. Ask mineswap.org for a route (rate limit: 30/min per IP; the kit spends at most 20/min and backs off on 429) and show what the kit would sign: the decoded router call and the result of the static guard checks. Signs nothing.',
  buy_bg: 'Buy BG with USDC through a pinned MineSwap router (v1 split router or router v2). When the quote is a stale-prone v1 entry-hop route, the kit sends v1 swapExactTokensForTokens [USDC, WETH, BG] it builds itself, sized from the quote. Guards: exact USDC approval to the router the swap targets, recipient = this wallet, floor ≥ the BG asked for, floor within the slippage cap of the kit\'s own simulation, per-transaction and per-day USD caps.',
  swap: 'Exact-input swap between USDC, ETH, WETH and BG (BG on exactly one side) through a pinned router, with the same guards as buy_bg. Every swap, sells included, must guarantee at least the reference price (router v1\'s own route) minus the slippage cap; BG is only sold through router v1. A stale-prone v1 entry-hop route is refused (STALE_PRONE_ROUTE): re-quote, or use buy_bg for USDC→BG.',
  activate_mine: 'Burn exactly 0.1 BG through MineBurnEntry (0xF121…6037) and mint this wallet\'s Gold Mine. Needs 0.1 BG (call buy_bg first). One mine per address.',
  login: 'Sign in to mineswap.app for this wallet\'s own Gold Mine: signs the exact war-auth SIWE challenge for www.mineswap.app and keeps the session token in memory.',
  state: 'The mine\'s game state (gold, level, upgrades, expedition). Needs login.',
  mine: 'Mine gold. The server caps clicks by elapsed time, allows 12 calls a minute and needs 5 s between calls (the kit waits). Needs login.',
  upgrade: 'Buy an upgrade with in-game gold. Needs login.',
  expedition: 'Start, claim or check an expedition (shallow, deep, legendary). Under the new expedition rules a start takes 10 / 20 / 30 scouts and a claim can fail (half the gold, half the scouts). Needs login.',
  claim: 'Smelted-BG cash-back: status lists claimable batches; claim queues them for payout to the mine owner\'s wallet (the server decides the destination). Needs login.',
};

const ANNOTATIONS: Record<ToolName, { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean }> = {
  wallet_status: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  quote: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  buy_bg: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  swap: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  activate_mine: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  login: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  state: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  mine: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  upgrade: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  expedition: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  claim: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

export function ok(v: unknown) {
  return { content: [{ type: 'text' as const, text: json(v) }] };
}

/**
 * What an error looks like to the agent: a guard refusal (code + the guard's own reason), or one of
 * the kit's typed transport/API errors, whose messages the kit wrote. Anything else is reported by
 * class name only; its detail (which can carry RPC or server text) goes to stderr, URL-redacted.
 */
export function fail(e: unknown, log: (line: string) => void = (l) => process.stderr.write(`${l}\n`)) {
  let text: string;
  if (isGuardRefusal(e)) {
    text = `REFUSED by the agent-kit guard (${e.code}): ${e.reason}. Nothing was signed for this step.`;
  } else if (isKitIncident(e)) {
    text = `WARNING (${e.code}): ${e.message}.`;
  } else if (e instanceof QuoteRefused || e instanceof GameApiError || e instanceof RateLimitedError || e instanceof HttpError) {
    text = `ERROR (${e.name}): ${e.message}`;
  } else {
    const name = (e as Error)?.name && /^[A-Za-z]{1,40}$/.test((e as Error).name) ? (e as Error).name : 'Error';
    text = `ERROR (${name}): the kit hit an unexpected error; the details are in its stderr log`;
    log(`[mineswap-agent-kit] tool error: ${String((e as Error)?.stack ?? e).replace(/https?:\/\/[^\s"']+/g, (u) => { try { return new URL(u).origin; } catch { return '<url>'; } }).slice(0, 2000)}`);
  }
  return { content: [{ type: 'text' as const, text }], isError: true };
}

type Handlers = { [K in ToolName]: (args: z.infer<(typeof TOOL_SCHEMAS)[K]>) => Promise<unknown> };

export function toolHandlers(kit: Kit): Handlers {
  const { wallet, dex, game } = kit;
  return {
    wallet_status: async () => {
      const b = await wallet.balances();
      return {
        address: wallet.address,
        signer: wallet.signerKind,
        balances: { ETH: formatUnits(b.eth, 18), USDC: formatUnits(b.usdc, 6), BG: formatUnits(b.bg, 18), WETH: formatUnits(b.weth, 18) },
        goldMine: await wallet.mineId(),
        limits: {
          maxSlippageBps: wallet.limits.maxSlippageBps,
          maxTxUsd: centsToUsd(wallet.limits.maxTxUsdCents),
          maxDailyUsd: centsToUsd(wallet.limits.maxDailyUsdCents),
          spentLast24hUsd: centsToUsd(wallet.spentLast24hCents()),
        },
        pins: { verifiedAtBlock: wallet.pinReport.block, checks: wallet.pinReport.checks.length, allPassed: wallet.pinReport.checks.every((c) => c.ok) },
        loggedIn: game.loggedIn,
      };
    },
    quote: async (a) => {
      const tIn = tokenBySymbol(a.tokenIn);
      const tOut = tokenBySymbol(a.tokenOut);
      if ((a.amountIn === undefined) === (a.amountOut === undefined)) throw new Error('give exactly one of amountIn or amountOut');
      const amountIn = a.amountIn !== undefined ? parseAmount(a.amountIn, tIn) : undefined;
      const amountOut = a.amountOut !== undefined ? parseAmount(a.amountOut, tOut) : undefined;
      return previewSwap(dex, wallet, {
        tokenIn: tIn.address, tokenOut: tOut.address, ...(amountIn !== undefined ? { amountIn } : {}), ...(amountOut !== undefined ? { amountOut } : {}),
        slippageBps: requestSlippageBps(wallet.limits.maxSlippageBps), recipient: wallet.address,
      }, { tokenIn: tIn.address, tokenOut: tOut.address, ...(amountIn !== undefined ? { exactSpend: amountIn } : {}), ...(amountOut !== undefined ? { minOutFloor: amountOut } : {}) },
      Math.floor(Date.now() / 1000));
    },
    buy_bg: (a) => buyBg(dex, wallet, { bgAmount: a.bgAmount, ...(a.maxUsdc !== undefined ? { maxUsdc: a.maxUsdc } : {}) }),
    swap: (a) => swap(dex, wallet, { tokenIn: a.tokenIn, tokenOut: a.tokenOut, amountIn: a.amountIn, ...(a.minAmountOut !== undefined ? { minAmountOut: a.minAmountOut } : {}) }),
    activate_mine: async () => ({ ...(await wallet.activateMine()), entry: ADDR.mineBurnEntry, nft: ADDR.goldMineNft }),
    login: () => game.login(),
    state: (a) => game.state(a.includeSmelter),
    mine: (a) => game.mine(a.clicks),
    upgrade: (a) => game.upgrade(a.upgradeId, a.count),
    expedition: (a) => game.expedition(a.action, a.type),
    claim: (a) => game.claim(a.action, a.batchId),
  };
}

/** A fresh McpServer with every tool registered against `kit`. */
export function createMcpServer(kit: Kit): McpServer {
  const server = new McpServer({ name: 'mineswap-agent-kit', version: KIT_VERSION }, { capabilities: { tools: {} } });
  const handlers = toolHandlers(kit);
  for (const name of Object.keys(TOOL_SCHEMAS) as ToolName[]) {
    const handler = handlers[name] as (args: unknown) => Promise<unknown>;
    server.registerTool(name, {
      title: name,
      description: DESCRIPTIONS[name],
      inputSchema: TOOL_SCHEMAS[name],
      annotations: ANNOTATIONS[name],
    }, (async (args: unknown) => {
      try {
        return ok(await handler(args));
      } catch (e) {
        return fail(e);
      }
    }) as never);
  }
  return server;
}
