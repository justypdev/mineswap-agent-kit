/**
 * Coinbase CDP server wallet (CDP SDK v2 server accounts, `@coinbase/cdp-sdk`). The key stays in
 * Coinbase's infrastructure; the kit holds API credentials that can ASK Coinbase to sign for one
 * named account.
 *
 * What a CDP wallet policy adds (policies/cdp-wallet-policy.json; README "The CDP wallet policy"):
 * Coinbase checks every request from these credentials against the account's allowlist. That holds
 * against a bug in, or a tricked, kit. It holds against a COMPROMISED kit host only when the API key
 * the kit uses cannot manage policies (CDP's "Non-custodial > Manage (modify policies)" API
 * restriction left OFF) and the policy is managed with a different key kept elsewhere. A policy is
 * per request: it has no aggregate or rolling limit, so it bounds each transaction, not a day.
 *
 * Credentials: from a 0600 JSON file owned by the user running the kit (`credentialsFile`:
 * { apiKeyId, apiKeySecret, walletSecret }), or from the environment the SDK reads
 * (CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET). Never inline in an MCP client config.
 * The kit never logs or forwards them. CDP usage tracking and error reporting are switched OFF by
 * default (DISABLE_CDP_USAGE_TRACKING / DISABLE_CDP_ERROR_REPORTING = true unless already set).
 */
import { readFileSync, statSync } from 'node:fs';
import { getAddress, type Address, type Hex } from 'viem';
import type { RawSigner } from './types.js';

/** The slice of CdpClient the kit uses — injectable so the adapter is unit-tested without Coinbase. */
export interface CdpClientLike {
  evm: {
    getOrCreateAccount(o: { name: string }): Promise<{ address: string; signMessage(p: { message: string }): Promise<Hex> }>;
    sendTransaction(o: {
      address: Address;
      network: 'base';
      transaction: { to: Address; data: Hex; value: bigint; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    }): Promise<{ transactionHash: Hex }>;
  };
}

export interface CdpCredentials { apiKeyId: string; apiKeySecret: string; walletSecret: string }

/** Read CDP credentials from a file only its owner can read. Never echoes a value. */
export function readCdpCredentialsFile(path: string): CdpCredentials {
  const st = statSync(path);
  if ((st.mode & 0o077) !== 0) throw new Error('the CDP credentials file is readable by other users; chmod 600 it');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('the CDP credentials file is not owned by the user running the kit');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('the CDP credentials file is not JSON');
  }
  const c = parsed as Partial<CdpCredentials>;
  for (const k of ['apiKeyId', 'apiKeySecret', 'walletSecret'] as const) {
    if (typeof c?.[k] !== 'string' || !c[k]) throw new Error(`the CDP credentials file has no ${k}`);
  }
  return { apiKeyId: c.apiKeyId!, apiKeySecret: c.apiKeySecret!, walletSecret: c.walletSecret! };
}

/** CDP telemetry off unless the operator opted in. */
export function defaultCdpTelemetryOff(env: NodeJS.ProcessEnv = process.env): void {
  env.DISABLE_CDP_USAGE_TRACKING ??= 'true';
  env.DISABLE_CDP_ERROR_REPORTING ??= 'true';
}

export async function createCdpSigner(opts: { accountName: string; credentialsFile?: string }, client?: CdpClientLike): Promise<RawSigner> {
  if (!/^[A-Za-z0-9-]{2,36}$/.test(opts.accountName)) throw new Error('cdp.accountName must be 2-36 letters, digits or hyphens');
  defaultCdpTelemetryOff();
  let cdp = client;
  if (!cdp) {
    let creds: CdpCredentials | undefined;
    if (opts.credentialsFile) creds = readCdpCredentialsFile(opts.credentialsFile);
    else {
      for (const k of ['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET']) {
        if (!process.env[k]) throw new Error(`${k} is not set; give signer.credentialsFile, or set CDP_API_KEY_ID, CDP_API_KEY_SECRET and CDP_WALLET_SECRET`);
      }
    }
    const { CdpClient } = await import('@coinbase/cdp-sdk');
    cdp = (creds ? new CdpClient(creds) : new CdpClient()) as unknown as CdpClientLike;
  }
  const account = await cdp.evm.getOrCreateAccount({ name: opts.accountName });
  const address = getAddress(account.address);
  return {
    kind: 'cdp',
    address,
    signMessage: (message) => account.signMessage({ message }),
    sendTransaction: async (tx) => {
      const { transactionHash } = await cdp!.evm.sendTransaction({
        address, network: 'base',
        transaction: { to: tx.to, data: tx.data, value: tx.value, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas },
      });
      return transactionHash;
    },
  };
}
