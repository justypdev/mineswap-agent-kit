/**
 * Kit configuration: one JSON file, validated strictly. Secrets are never put in it: the CDP
 * credentials stay in the environment the CDP SDK reads, and an RPC URL that carries a key can be
 * given as a path (`rpcUrlFile`) so it never sits in the config or on a command line.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DEFAULT_LIMITS, HARD_MAX_DEADLINE_SECONDS, HARD_MAX_SLIPPAGE_BPS, dollarsToCents, type Limits } from './guard/policy.js';

const expandHome = (p: string) => (p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p));

const SignerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cdp'), accountName: z.string().regex(/^[A-Za-z0-9-]{2,36}$/), credentialsFile: z.string().min(1).optional() }).strict(),
  z.object({ type: z.literal('local-test'), keyFile: z.string().min(1), acknowledgeTestOnly: z.literal(true) }).strict(),
]);

export const ConfigSchema = z.object({
  rpcUrl: z.string().url().optional(),
  rpcUrlFile: z.string().min(1).optional(),
  signer: SignerSchema,
  limits: z.object({
    maxSlippageBps: z.number().int().min(1).max(HARD_MAX_SLIPPAGE_BPS).optional(),
    maxTxUsd: z.number().positive().max(1_000_000).optional(),
    maxDailyUsd: z.number().positive().max(1_000_000).optional(),
    maxDeadlineSeconds: z.number().int().min(60).max(HARD_MAX_DEADLINE_SECONDS).optional(),
    maxGasPerTx: z.number().int().min(100_000).max(10_000_000).optional(),
    maxFeePerGasGwei: z.number().positive().max(100).optional(),
  }).strict().optional(),
  ledgerPath: z.string().min(1).optional(),
  /** The ledger's high-water sentinel; must be in a different directory from the ledger. */
  ledgerSentinelPath: z.string().min(1).optional(),
}).strict().refine((c) => !(c.rpcUrl && c.rpcUrlFile), { message: 'give rpcUrl or rpcUrlFile, not both' });

export type KitConfigFile = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig {
  readonly rpcUrl: string;
  /** For logs: the RPC host only, never the full URL (it may carry a key in its path). */
  readonly rpcHost: string;
  readonly signer: z.infer<typeof SignerSchema>;
  readonly limits: Limits;
  readonly ledgerPath: string;
  readonly ledgerSentinelPath: string;
}

export function resolveConfig(raw: unknown): ResolvedConfig {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid kit config: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
  }
  const c = parsed.data;
  const rpcUrl = c.rpcUrlFile ? readFileSync(expandHome(c.rpcUrlFile), 'utf8').trim() : (c.rpcUrl ?? 'https://mainnet.base.org');
  let rpcHost: string;
  try {
    const u = new URL(rpcUrl);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error('scheme');
    rpcHost = u.host;
  } catch {
    throw new Error('the RPC URL must be https (or http on localhost for a fork)');
  }
  const maxTx = c.limits?.maxTxUsd !== undefined ? dollarsToCents(c.limits.maxTxUsd) : DEFAULT_LIMITS.maxTxUsdCents;
  const maxDay = c.limits?.maxDailyUsd !== undefined ? dollarsToCents(c.limits.maxDailyUsd) : DEFAULT_LIMITS.maxDailyUsdCents;
  if (maxTx > maxDay) throw new Error('limits.maxTxUsd cannot exceed limits.maxDailyUsd');
  const signer = c.signer.type === 'local-test'
    ? { ...c.signer, keyFile: expandHome(c.signer.keyFile) }
    : { ...c.signer, ...(c.signer.credentialsFile ? { credentialsFile: expandHome(c.signer.credentialsFile) } : {}) };
  const ledgerPath = expandHome(c.ledgerPath ?? '~/.mineswap-agent-kit/spend-ledger.json');
  const ledgerSentinelPath = expandHome(c.ledgerSentinelPath ?? '~/.config/mineswap-agent-kit/spend-ledger.sentinel');
  return {
    rpcUrl,
    rpcHost,
    signer,
    limits: Object.freeze({
      maxSlippageBps: c.limits?.maxSlippageBps ?? DEFAULT_LIMITS.maxSlippageBps,
      maxTxUsdCents: maxTx,
      maxDailyUsdCents: maxDay,
      maxDeadlineSeconds: c.limits?.maxDeadlineSeconds ?? DEFAULT_LIMITS.maxDeadlineSeconds,
      maxGasPerTx: c.limits?.maxGasPerTx !== undefined ? BigInt(c.limits.maxGasPerTx) : DEFAULT_LIMITS.maxGasPerTx,
      maxFeePerGasWei: c.limits?.maxFeePerGasGwei !== undefined ? BigInt(Math.round(c.limits.maxFeePerGasGwei * 1e9)) : DEFAULT_LIMITS.maxFeePerGasWei,
    }),
    ledgerPath,
    ledgerSentinelPath,
  };
}

export function loadConfigFile(path: string): ResolvedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(expandHome(path), 'utf8'));
  } catch (e) {
    throw new Error(`cannot read the kit config at ${path}: ${(e as Error).message.split('\n')[0]}`);
  }
  return resolveConfig(raw);
}
