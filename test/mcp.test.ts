import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { DexClient } from '../src/dex.js';
import { GameClient } from '../src/game.js';
import { HttpClient } from '../src/http.js';
import type { Kit } from '../src/kit.js';
import { TOOL_SCHEMAS, createMcpServer } from '../src/mcp/server.js';
import { ADDR } from '../src/pins.js';
import { ATTACKER, FakeChain, v1Entry, walletOn } from './helpers.js';

async function connect(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const chain = new FakeChain();
  chain.setBal(ADDR.usdc, 3_000_000n);
  const wallet = walletOn(chain);
  const http = new HttpClient({ fetch: fetchImpl });
  const kit: Kit = { wallet, dex: new DexClient(http), game: new GameClient(http, wallet), config: resolveConfig({ signer: { type: 'cdp', accountName: 'mineswap-agent' } }) };
  const server = createMcpServer(kit);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, chain };
}

const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('MCP tool contracts', () => {
  it('lists exactly the kit tools with their schemas', async () => {
    const { client } = await connect(json({}));
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(['activate_mine', 'buy_bg', 'claim', 'expedition', 'login', 'mine', 'quote', 'state', 'swap', 'upgrade', 'wallet_status']);
    expect(Object.keys(byName).sort()).toEqual(Object.keys(TOOL_SCHEMAS).sort());

    const props = (n: string) => (byName[n]!.inputSchema as { properties?: Record<string, any>; required?: string[] });
    expect(props('swap').required?.sort()).toEqual(['amountIn', 'tokenIn', 'tokenOut']);
    expect(props('swap').properties!.tokenIn.enum).toEqual(['USDC', 'BG', 'WETH', 'ETH']);
    expect(props('buy_bg').properties!.bgAmount.default).toBe('0.1');
    expect(props('mine').required).toEqual(['clicks']);
    expect(props('mine').properties!.clicks).toMatchObject({ type: 'integer', minimum: 1, maximum: 10000 });
    expect(props('upgrade').properties!.upgradeId.enum).toContain('pickaxe');
    expect(props('expedition').properties!.type.enum).toEqual(['shallow', 'deep', 'legendary']);
    expect(props('claim').properties!.action.enum).toEqual(['status', 'claim', 'history']);
    // No tool accepts an address, a recipient, a spender, raw calldata or a message to sign.
    for (const t of tools) {
      const keys = Object.keys((t.inputSchema as { properties?: object }).properties ?? {});
      for (const k of keys) expect(k).not.toMatch(/^(to|recipient|spender|address|data|calldata|message|signature|hmac|router)$/i);
    }
    expect(byName.quote!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.buy_bg!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('rejects arguments outside the schema', async () => {
    const { client, chain } = await connect(json({}));
    const r = await client.callTool({ name: 'swap', arguments: { tokenIn: 'DEGEN', tokenOut: 'BG', amountIn: '1' } });
    expect(r.isError).toBe(true);
    const r2 = await client.callTool({ name: 'mine', arguments: { clicks: 0 } });
    expect(r2.isError).toBe(true);
    expect(chain.sent).toHaveLength(0);
  });

  it('a guard refusal comes back as a tool error that names the rule', async () => {
    const quote = { ok: true, executable: true, amountIn: '1060000', amountOut: '1', amountOutMin: '1', calldata: { to: ADDR.routerV1, data: v1Entry({ to: ATTACKER }), value: '0' } };
    const { client, chain } = await connect(json(quote));
    const r = await client.callTool({ name: 'buy_bg', arguments: { bgAmount: '0.1' } });
    expect(r.isError).toBe(true);
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/^REFUSED by the agent-kit guard \(RECIPIENT_NOT_SELF\)/);
    expect(text).toContain('Nothing was signed');
    expect(chain.sent).toHaveLength(0);
  });

  it('wallet_status is read-only and reports caps and pin status', async () => {
    const { client, chain } = await connect(json({}));
    const r = await client.callTool({ name: 'wallet_status', arguments: {} });
    const body = JSON.parse((r.content as Array<{ text: string }>)[0]!.text);
    expect(body).toMatchObject({ signer: 'local-test', balances: { USDC: '3' }, limits: { maxTxUsd: '$5.00', maxDailyUsd: '$20.00', maxSlippageBps: 100 }, pins: { allPassed: true } });
    expect(chain.sent).toHaveLength(0);
  });

  it('errors never echo a full URL (an RPC URL can carry a key)', async () => {
    const { client } = await connect(async () => { throw new Error('connect ECONNREFUSED https://lb.example/base/SECRETKEY123'); });
    const r = await client.callTool({ name: 'quote', arguments: { tokenIn: 'USDC', tokenOut: 'BG', amountOut: '0.1' } });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    expect(r.isError).toBe(true);
    expect(text).not.toContain('SECRETKEY123');
  });
});
