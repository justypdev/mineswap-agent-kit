#!/usr/bin/env node
/**
 * mineswap-agent-kit — the MCP server over stdio.
 *
 *   mineswap-agent-kit --config ~/.mineswap-agent-kit/config.json
 *   (or MINESWAP_AGENT_KIT_CONFIG=<path>)
 *
 * stdout carries the MCP protocol only; every log line goes to stderr. The kit verifies every
 * pinned contract on chain before it serves a single tool, and exits when one does not match.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfigFile } from './config.js';
import { centsToUsd } from './guard/policy.js';
import { createKit } from './kit.js';
import { createMcpServer, KIT_VERSION } from './mcp/server.js';
import { defaultCdpTelemetryOff } from './signers/cdp.js';

// Before anything can load the CDP SDK: its usage tracking and error reporting stay off unless the
// operator set DISABLE_CDP_USAGE_TRACKING / DISABLE_CDP_ERROR_REPORTING themselves.
defaultCdpTelemetryOff();

/** Any URL in a log line is cut to its origin: an RPC URL can carry an API key in its path. */
const redactUrls = (l: string) => l.replace(/https?:\/\/[^\s"']+/g, (u) => { try { return new URL(u).origin; } catch { return '<url>'; } });
const log = (l: string) => process.stderr.write(`[mineswap-agent-kit] ${redactUrls(l)}\n`);

function configPath(argv: string[]): string {
  const i = argv.indexOf('--config');
  const p = i >= 0 ? argv[i + 1] : process.env.MINESWAP_AGENT_KIT_CONFIG;
  if (!p) throw new Error('no config: pass --config <path> or set MINESWAP_AGENT_KIT_CONFIG');
  return p;
}

async function main(): Promise<void> {
  const config = loadConfigFile(configPath(process.argv.slice(2)));
  log(`v${KIT_VERSION}: signer=${config.signer.type} rpc=${config.rpcHost} ledger=${config.ledgerPath}`);
  const kit = await createKit(config, { log });
  const r = kit.wallet.pinReport;
  log(`pins verified on chain ${r.chainId} at block ${r.block}: ${r.checks.length}/${r.checks.length} checks passed`);
  log(`wallet ${kit.wallet.address}; caps ${centsToUsd(config.limits.maxTxUsdCents)}/tx, ${centsToUsd(config.limits.maxDailyUsdCents)}/24 h, slippage ${config.limits.maxSlippageBps} bps`);
  serveStdio(() => createMcpServer(kit), { onerror: (e) => log(`transport error: ${e.message}`) });
}

main().catch((e: unknown) => {
  log(`refusing to start: ${(e as Error)?.message ?? String(e)}`);
  process.exit(1);
});
