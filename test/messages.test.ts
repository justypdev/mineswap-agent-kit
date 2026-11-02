import { describe, expect, it } from 'vitest';
import { authorizeMessage, buildSessionMessage, buildWarAuthMessage } from '../src/guard/messages.js';
import { GuardRefusal } from '../src/guard/refusal.js';
import { ADDR } from '../src/pins.js';
import { FakeChain, NOW_MS, SELF, walletOn } from './helpers.js';

/**
 * Produced by mineswap.app's own war-auth builder (domain www.mineswap.app, uri
 * https://www.mineswap.app, Gold Mine #68) and accepted by its server-side check (cross-checked on
 * 2026-11-02, when the statement became the plain-words one).
 */
const GOLDEN_WAR_AUTH =
  'www.mineswap.app wants you to sign in with your Ethereum account:\n0x52908400098527886E0F7030069857D2E4169EE7\n\n' +
  'Sign in to MineSwap to play your Gold Mine #68. This is a free signature, not a transaction; it can\'t move your tokens or NFTs, and it expires in 5 minutes.' +
  '\n\nURI: https://www.mineswap.app\nVersion: 1\nChain ID: 8453\n' +
  'Nonce: abcDEF1234567890\nIssued At: 2026-10-31T14:00:00.000Z\nExpiration Time: 2026-10-31T14:05:00.000Z';
/** The same challenge in the pre-2026-11-02 wording: the server still accepts it, the kit no longer signs it. */
const LEGACY_WAR_AUTH = GOLDEN_WAR_AUTH.replace(
  "Sign in to MineSwap to play your Gold Mine #68. This is a free signature, not a transaction; it can't move your tokens or NFTs, and it expires in 5 minutes.",
  'BaseGold war session for goldmine #68 (stack -).',
);
const WAR_STATEMENT = "Sign in to MineSwap to play your Gold Mine #68. This is a free signature, not a transaction; it can't move your tokens or NFTs, and it expires in 5 minutes.";

/**
 * Produced by mineswap.app's own play-session builder (domain www.mineswap.app, uri
 * https://www.mineswap.app) and accepted by its server-side check, which refuses the retired text
 * as an old format (cross-checked on 2026-10-31).
 */
const SIWE_TAIL = '\n\nURI: https://www.mineswap.app\nVersion: 1\nChain ID: 8453\nNonce: abcDEF1234567890\nIssued At: 2026-10-31T14:00:00.000Z\nExpiration Time: 2026-10-31T14:05:00.000Z';
const GOLDEN_SESSION_CREATE = 'www.mineswap.app wants you to sign in with your Ethereum account:\n0x52908400098527886E0F7030069857D2E4169EE7\n\nMineSwap play session for this device.' + SIWE_TAIL;
const GOLDEN_SESSION_TAKEOVER = 'www.mineswap.app wants you to sign in with your Ethereum account:\n0x52908400098527886E0F7030069857D2E4169EE7\n\nMineSwap play session for this device, replacing the session on any other device.' + SIWE_TAIL;
const RETIRED_SESSION = `BaseGold Miner Session\nAddress: ${SELF.toLowerCase()}\nTimestamp: ${NOW_MS}`;
const session = (action: 'create' | 'takeover', o: Partial<{ wallet: typeof SELF; timestamp: number }> = {}) =>
  buildSessionMessage({ wallet: o.wallet ?? SELF, action, timestamp: o.timestamp ?? NOW_MS, nonce: 'abcDEF1234567890' });

const ctx: { self: typeof SELF; mineId: number | null; nowMs: number } = { self: SELF, mineId: 68, nowMs: NOW_MS + 1_000 };
const refusedWith = (text: unknown, c = ctx) => {
  try {
    authorizeMessage(text, c);
    return 'SIGNED';
  } catch (e) {
    return (e as GuardRefusal).code;
  }
};
const golden = buildWarAuthMessage({ wallet: SELF, tokenId: 68, timestamp: NOW_MS, nonce: 'abcDEF1234567890' });

describe('the login-message allowlist', () => {
  it('the kit builds the exact war-auth challenge the app builds (golden)', () => {
    expect(golden).toBe(GOLDEN_WAR_AUTH);
  });

  it('accepts exactly the war-auth challenge for this wallet and its own mine', () => {
    expect(authorizeMessage(GOLDEN_WAR_AUTH, ctx)).toEqual({ kind: 'war-auth', tokenId: 68, timestamp: NOW_MS });
  });

  it('the kit builds the exact play-session messages mineswap.app builds (golden)', () => {
    expect(session('create')).toBe(GOLDEN_SESSION_CREATE);
    expect(session('takeover')).toBe(GOLDEN_SESSION_TAKEOVER);
  });

  it('accepts exactly the play-session messages for this wallet, with or without a mine', () => {
    expect(authorizeMessage(GOLDEN_SESSION_CREATE, ctx)).toEqual({ kind: 'session', action: 'create', timestamp: NOW_MS });
    expect(authorizeMessage(GOLDEN_SESSION_TAKEOVER, { ...ctx, mineId: null })).toEqual({ kind: 'session', action: 'takeover', timestamp: NOW_MS });
  });

  it('refuses the retired "BaseGold Miner Session" text, which the server now refuses too', () => {
    expect(refusedWith(RETIRED_SESSION)).toBe('MESSAGE_NOT_ALLOWED');
    expect(() => authorizeMessage(RETIRED_SESSION, ctx)).toThrow(/retired/);
  });

  const hostile: Array<[string, unknown]> = [
    ['an arbitrary "please sign" text', 'Please sign to verify your wallet'],
    ['an empty string', ''],
    ['a non-string', { message: GOLDEN_WAR_AUTH }],
    ['a 32-byte hex blob (a hash to blind-sign)', `0x${'ab'.repeat(32)}`],
    ['a SIWE challenge for a phishing domain', GOLDEN_WAR_AUTH.replace('www.mineswap.app wants', 'mineswap-app.com wants')],
    ['a SIWE challenge for the bare mineswap.app host', GOLDEN_WAR_AUTH.replace('www.mineswap.app wants', 'mineswap.app wants')],
    ['a SIWE challenge with another URI', GOLDEN_WAR_AUTH.replace('URI: https://www.mineswap.app', 'URI: https://evil.example')],
    ['a SIWE challenge for another wallet', GOLDEN_WAR_AUTH.replace('0x52908400098527886E0F7030069857D2E4169EE7', '0x000000000000000000000000000000000000bEEF')],
    ['a SIWE challenge for someone else\'s mine', GOLDEN_WAR_AUTH.replace('Gold Mine #68', 'Gold Mine #1')],
    ['a SIWE challenge for a clanker stack', GOLDEN_WAR_AUTH.replace('Gold Mine #68', 'Clanker V1 Mine #68')],
    ['the pre-2026-11-02 wording (the kit signs only the current one)', LEGACY_WAR_AUTH],
    ['a SIWE challenge on another chain', GOLDEN_WAR_AUTH.replace('Chain ID: 8453', 'Chain ID: 1')],
    ['a SIWE challenge with a 1-day expiry', GOLDEN_WAR_AUTH.replace('2026-10-31T14:05:00.000Z', '2026-11-01T14:00:00.000Z')],
    ['a SIWE challenge with an extra Resources line', `${GOLDEN_WAR_AUTH}\nResources:\n- https://evil.example/drain`],
    ['a SIWE challenge with a trailing newline', `${GOLDEN_WAR_AUTH}\n`],
    ['a SIWE challenge with a different statement', GOLDEN_WAR_AUTH.replace(WAR_STATEMENT, 'I authorize transfer of my mine.')],
    ['a session message for another wallet', session('create', { wallet: '0x000000000000000000000000000000000000bEEF' })],
    ['a session message for a phishing domain', GOLDEN_SESSION_CREATE.replace('www.mineswap.app wants', 'mineswap-app.com wants')],
    ['a session message on another chain', GOLDEN_SESSION_CREATE.replace('Chain ID: 8453', 'Chain ID: 1')],
    ['a session message with a 1-day expiry', GOLDEN_SESSION_CREATE.replace('2026-10-31T14:05:00.000Z', '2026-11-01T14:00:00.000Z')],
    ['a session message with an extra Resources line', `${GOLDEN_SESSION_CREATE}\nResources:\n- https://evil.example`],
    ['a session statement with a typo', GOLDEN_SESSION_CREATE.replace('for this device.', 'for this device!')],
    ['the retired session text with an upper-case address', `BaseGold Miner Session\nAddress: ${SELF}\nTimestamp: ${NOW_MS}`],
    ['the retired session text with an extra line', `${RETIRED_SESSION}\nApprove: all`],
  ];
  it.each(hostile)('refuses %s', (_name, text) => {
    expect(refusedWith(text)).toBe('MESSAGE_NOT_ALLOWED');
  });

  it('refuses stale and future-dated challenges (5-minute window)', () => {
    expect(refusedWith(GOLDEN_WAR_AUTH, { ...ctx, nowMs: NOW_MS + 5 * 60_000 + 1 })).toBe('MESSAGE_NOT_ALLOWED');
    expect(refusedWith(GOLDEN_WAR_AUTH, { ...ctx, nowMs: NOW_MS - 5 * 60_000 - 1 })).toBe('MESSAGE_NOT_ALLOWED');
    expect(refusedWith(GOLDEN_SESSION_CREATE, { ...ctx, nowMs: NOW_MS + 10 * 60_000 })).toBe('MESSAGE_NOT_ALLOWED');
  });

  it('refuses a war-auth challenge when the wallet has no mine', () => {
    expect(refusedWith(GOLDEN_WAR_AUTH, { ...ctx, mineId: null })).toBe('MESSAGE_NOT_ALLOWED');
  });

  it('the wallet signs only what passes, and never typed data', async () => {
    const chain = new FakeChain();
    chain.mineId = 68n;
    const w = walletOn(chain);
    const fresh = buildWarAuthMessage({ wallet: SELF, tokenId: 68, timestamp: NOW_MS, nonce: 'zzzzzzzz1' });
    await expect(w.signLoginMessage(fresh)).resolves.toMatchObject({ authorized: { kind: 'war-auth', tokenId: 68 } });
    await expect(w.signLoginMessage('Sign this to claim your airdrop')).rejects.toMatchObject({ code: 'MESSAGE_NOT_ALLOWED' });
    await expect(w.signTypedData({ domain: { verifyingContract: ADDR.usdc }, primaryType: 'Permit' })).rejects.toMatchObject({ code: 'TYPED_DATA_REFUSED' });
    expect(chain.signed).toEqual([fresh]);
  });
});
