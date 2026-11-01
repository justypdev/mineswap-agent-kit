/**
 * Assembles the kit: RPC client → signer → GuardedWallet (pins verified on chain before it exists)
 * → the dex and game clients. Nothing here signs; only GuardedWallet does.
 */
import { createPublicClient, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import type { ResolvedConfig } from './config.js';
import { DexClient } from './dex.js';
import { GameClient } from './game.js';
import { FileLedger, type SpendLedger } from './guard/ledger.js';
import { GuardedWallet } from './guard/wallet.js';
import { HttpClient, type FetchLike } from './http.js';
import { QUOTE_RATE_LIMIT_PER_MINUTE } from './pins.js';
import { createCdpSigner, type CdpClientLike } from './signers/cdp.js';
import { createLocalTestSigner } from './signers/local.js';
import type { RawSigner } from './signers/types.js';

export interface Kit {
  readonly wallet: GuardedWallet;
  readonly dex: DexClient;
  readonly game: GameClient;
  readonly config: ResolvedConfig;
}

/**
 * Test harness hooks. Every one except `log` can replace something the guard relies on (the chain,
 * the signer, the HTTP transport, the ledger), so they are refused unless the process is a test:
 * vitest (VITEST=true) or a harness that sets MINESWAP_AGENT_KIT_TEST_OVERRIDES=1 explicitly.
 */
export interface KitOverrides {
  readonly client?: PublicClient;
  readonly fetch?: FetchLike;
  readonly ledger?: SpendLedger;
  readonly cdpClient?: CdpClientLike;
  readonly signer?: RawSigner;
  readonly log?: (line: string) => void;
}

export function testOverridesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VITEST === 'true' || env.MINESWAP_AGENT_KIT_TEST_OVERRIDES === '1';
}

export async function createKit(config: ResolvedConfig, o: KitOverrides = {}): Promise<Kit> {
  const used = (['client', 'fetch', 'ledger', 'cdpClient', 'signer'] as const).filter((k) => o[k] !== undefined);
  if (used.length && !testOverridesAllowed()) {
    throw new Error(`createKit overrides (${used.join(', ')}) are for tests only; set MINESWAP_AGENT_KIT_TEST_OVERRIDES=1 in a test harness`);
  }
  const log = o.log ?? ((l: string) => process.stderr.write(`${l}\n`));
  const client = o.client ?? (createPublicClient({ chain: base, transport: http(config.rpcUrl, { retryCount: 2 }) }) as PublicClient);
  const signer = o.signer
    ?? (config.signer.type === 'cdp'
      ? await createCdpSigner({ accountName: config.signer.accountName, ...(config.signer.credentialsFile ? { credentialsFile: config.signer.credentialsFile } : {}) }, o.cdpClient)
      : createLocalTestSigner({ keyFile: config.signer.keyFile, rpcUrl: config.rpcUrl, acknowledgeTestOnly: config.signer.acknowledgeTestOnly }, log));
  const wallet = await GuardedWallet.create({ client, signer, limits: config.limits, ledger: o.ledger ?? new FileLedger(config.ledgerPath, config.ledgerSentinelPath) });
  // One budget per origin: the quote API's limit is per IP, the game's are per route.
  const dexHttp = new HttpClient({ fetch: o.fetch, maxPerMinute: Math.floor(QUOTE_RATE_LIMIT_PER_MINUTE * 2 / 3) });
  const gameHttp = new HttpClient({ fetch: o.fetch, maxPerMinute: 20 });
  return { wallet, dex: new DexClient(dexHttp), game: new GameClient(gameHttp, wallet), config };
}
