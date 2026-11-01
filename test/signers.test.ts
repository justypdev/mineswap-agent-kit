import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { createCdpSigner, defaultCdpTelemetryOff, readCdpCredentialsFile, type CdpClientLike } from '../src/signers/cdp.js';
import { LOCAL_SIGNER_WARNING, createLocalTestSigner } from '../src/signers/local.js';
import { ADDR } from '../src/pins.js';

describe('CDP server-wallet signer (CDP SDK v2 server accounts)', () => {
  it('uses getOrCreateAccount by name and sends on network "base"', async () => {
    const calls: unknown[] = [];
    const fake: CdpClientLike = {
      evm: {
        getOrCreateAccount: async (o) => { calls.push(['getOrCreateAccount', o]); return { address: '0x52908400098527886e0f7030069857d2e4169ee7', signMessage: async (p) => { calls.push(['signMessage', p]); return '0x01'; } }; },
        sendTransaction: async (o) => { calls.push(['sendTransaction', o]); return { transactionHash: `0x${'aa'.repeat(32)}` }; },
      },
    };
    const s = await createCdpSigner({ accountName: 'mineswap-agent' }, fake);
    expect(s.kind).toBe('cdp');
    expect(s.address).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
    await s.signMessage('hello');
    await s.sendTransaction({ to: ADDR.mineBurnEntry, data: '0x0f15f4c0', value: 0n, gas: 200_000n, maxFeePerGas: 9n, maxPriorityFeePerGas: 1n });
    expect(calls).toEqual([
      ['getOrCreateAccount', { name: 'mineswap-agent' }],
      ['signMessage', { message: 'hello' }],
      ['sendTransaction', { address: '0x52908400098527886E0F7030069857D2E4169EE7', network: 'base', transaction: { to: ADDR.mineBurnEntry, data: '0x0f15f4c0', value: 0n, gas: 200_000n, maxFeePerGas: 9n, maxPriorityFeePerGas: 1n } }],
    ]);
  });

  it('reads credentials from a 0600 file it owns, refusing a world-readable one, and never echoes a value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kit-cdp-'));
    const f = join(dir, 'creds.json');
    writeFileSync(f, JSON.stringify({ apiKeyId: 'id-123', apiKeySecret: 'SECRET-abc', walletSecret: 'WALLET-xyz' }), { mode: 0o600 });
    expect(readCdpCredentialsFile(f)).toEqual({ apiKeyId: 'id-123', apiKeySecret: 'SECRET-abc', walletSecret: 'WALLET-xyz' });
    chmodSync(f, 0o644);
    expect(() => readCdpCredentialsFile(f)).toThrow(/readable by other users/);
    chmodSync(f, 0o600);
    writeFileSync(f, JSON.stringify({ apiKeyId: 'id-123', apiKeySecret: 'SECRET-abc' }), { mode: 0o600 });
    let msg = '';
    try { readCdpCredentialsFile(f); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/no walletSecret/);
    expect(msg).not.toContain('SECRET-abc');
  });

  it('switches CDP telemetry off unless the operator chose otherwise', () => {
    const env: NodeJS.ProcessEnv = {};
    defaultCdpTelemetryOff(env);
    expect(env).toEqual({ DISABLE_CDP_USAGE_TRACKING: 'true', DISABLE_CDP_ERROR_REPORTING: 'true' });
    const optedIn: NodeJS.ProcessEnv = { DISABLE_CDP_USAGE_TRACKING: 'false' };
    defaultCdpTelemetryOff(optedIn);
    expect(optedIn.DISABLE_CDP_USAGE_TRACKING).toBe('false');
  });

  it('refuses to start without the CDP credentials in the environment (and never names their values)', async () => {
    const saved = { ...process.env };
    delete process.env.CDP_API_KEY_ID; delete process.env.CDP_API_KEY_SECRET; delete process.env.CDP_WALLET_SECRET;
    try {
      await expect(createCdpSigner({ accountName: 'mineswap-agent' })).rejects.toThrow(/CDP_API_KEY_ID is not set/);
    } finally {
      Object.assign(process.env, saved);
    }
    await expect(createCdpSigner({ accountName: 'bad name!' }, {} as CdpClientLike)).rejects.toThrow(/accountName/);
  });
});

describe('local test-key signer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-key-'));
  // A random key generated at test time; never used on any chain.
  const KEY = generatePrivateKey();
  const file = join(dir, 'key');
  writeFileSync(file, `${KEY}\n`, { mode: 0o600 });

  it('demands the explicit testing acknowledgement', () => {
    expect(() => createLocalTestSigner({ keyFile: file, rpcUrl: 'http://127.0.0.1:1', acknowledgeTestOnly: false })).toThrow(/testing only/);
  });

  it('warns loudly on every start, and again when the key file is world-readable', () => {
    const lines: string[] = [];
    const s = createLocalTestSigner({ keyFile: file, rpcUrl: 'http://127.0.0.1:1', acknowledgeTestOnly: true }, (l) => lines.push(l));
    expect(lines).toEqual([LOCAL_SIGNER_WARNING]);
    expect(s.kind).toBe('local-test');
    expect(s.address).toBe(privateKeyToAccount(KEY).address);
    chmodSync(file, 0o644);
    const lines2: string[] = [];
    createLocalTestSigner({ keyFile: file, rpcUrl: 'http://127.0.0.1:1', acknowledgeTestOnly: true }, (l) => lines2.push(l));
    expect(lines2[1]).toMatch(/readable by other users/);
    chmodSync(file, 0o600);
  });

  it('refuses a key file that does not hold exactly one hex key', () => {
    const bad = join(dir, 'bad');
    writeFileSync(bad, 'not a key', { mode: 0o600 });
    expect(() => createLocalTestSigner({ keyFile: bad, rpcUrl: 'http://127.0.0.1:1', acknowledgeTestOnly: true }, () => {})).toThrow(/one 0x-prefixed/);
  });
});
