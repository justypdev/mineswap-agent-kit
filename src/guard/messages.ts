/**
 * The two game-login message formats, and the ONLY text the kit will sign. Both are EIP-4361
 * (SIWE) messages for www.mineswap.app on Base, with a 5-minute expiry, and the server rebuilds
 * each one and compares the WHOLE string:
 *
 *      www.mineswap.app wants you to sign in with your Ethereum account:
 *      <checksummed wallet>
 *
 *      <statement>
 *
 *      URI: https://www.mineswap.app
 *      Version: 1
 *      Chain ID: 8453
 *      Nonce: <random alphanumeric>
 *      Issued At: <timestamp ISO>
 *      Expiration Time: <timestamp + 5 min ISO>
 *
 * 1. War-auth (POST /api/war-auth). Statement:
 *      BaseGold war session for goldmine #<tokenId> (stack -).
 * 2. Play session (POST /api/session, action create / takeover). Statement:
 *      MineSwap play session for this device.                                      (create)
 *      MineSwap play session for this device, replacing the session on any other device.  (takeover)
 *
 * The older play-session text (`BaseGold Miner Session\nAddress: …\nTimestamp: …`) carried no
 * domain binding; mineswap.app's server refuses it, and so does the kit.
 *
 * `authorizeMessage` does not pattern-match the text it is handed. It parses out the variable
 * fields, REBUILDS the message from the kit's own pins (domain, URI, chain, the statement, its own
 * address and its own mine id) and accepts only an exact string match within the 5-minute window.
 * Everything else — a SIWE message for another domain, another address, another mine, an
 * arbitrary "please sign" text, a hex blob, the retired session text — is refused.
 */
import { getAddress, type Address } from 'viem';
import { createSiweMessage, parseSiweMessage } from 'viem/siwe';
import { BASE_CHAIN_ID, GAME_HOST, GAME_ORIGIN, sameAddress } from '../pins.js';
import { refuse } from './refusal.js';

export const LOGIN_TTL_MS = 5 * 60 * 1000;
const NONCE = /^[A-Za-z0-9]{8,96}$/;
const RETIRED_SESSION_PREFIX = 'BaseGold Miner Session';

export type SessionAction = 'create' | 'takeover';

export function warAuthStatement(tokenId: number): string {
  return `BaseGold war session for goldmine #${tokenId} (stack -).`;
}

/** The play-session statement mineswap.app's server rebuilds, verbatim. */
export function sessionStatement(action: SessionAction): string {
  return action === 'takeover'
    ? 'MineSwap play session for this device, replacing the session on any other device.'
    : 'MineSwap play session for this device.';
}

function buildGameSiwe(p: { wallet: Address; statement: string; timestamp: number; nonce: string }): string {
  if (!Number.isSafeInteger(p.timestamp)) throw new Error('timestamp must be whole milliseconds');
  if (!NONCE.test(p.nonce)) throw new Error('nonce must be 8-96 alphanumeric characters');
  return createSiweMessage({
    domain: GAME_HOST,
    address: getAddress(p.wallet),
    statement: p.statement,
    uri: GAME_ORIGIN,
    version: '1',
    chainId: BASE_CHAIN_ID,
    nonce: p.nonce,
    issuedAt: new Date(p.timestamp),
    expirationTime: new Date(p.timestamp + LOGIN_TTL_MS),
  });
}

export function buildWarAuthMessage(p: { wallet: Address; tokenId: number; timestamp: number; nonce: string }): string {
  if (!Number.isSafeInteger(p.tokenId) || p.tokenId <= 0) throw new Error('tokenId must be a positive integer');
  return buildGameSiwe({ wallet: p.wallet, statement: warAuthStatement(p.tokenId), timestamp: p.timestamp, nonce: p.nonce });
}

/** The /api/session create/takeover message, exactly as mineswap.app's server rebuilds it. */
export function buildSessionMessage(p: { wallet: Address; action: SessionAction; timestamp: number; nonce: string }): string {
  return buildGameSiwe({ wallet: p.wallet, statement: sessionStatement(p.action), timestamp: p.timestamp, nonce: p.nonce });
}

export type AuthorizedMessage =
  | { kind: 'war-auth'; tokenId: number; timestamp: number }
  | { kind: 'session'; action: SessionAction; timestamp: number };

export interface MessageContext {
  readonly self: Address;
  /** The wallet's own Gold Mine id, read on chain; null when it has none (war-auth is then refused). */
  readonly mineId: number | null;
  readonly nowMs: number;
}

export function authorizeMessage(text: unknown, ctx: MessageContext): AuthorizedMessage {
  if (typeof text !== 'string' || text.length === 0 || text.length > 2_000) {
    refuse('MESSAGE_NOT_ALLOWED', 'only the two MineSwap game-login messages are ever signed');
  }
  const message = text as string;

  if (message.startsWith(RETIRED_SESSION_PREFIX)) {
    refuse('MESSAGE_NOT_ALLOWED', 'the old "BaseGold Miner Session" text has no domain binding and is retired; play sessions sign the www.mineswap.app SIWE message');
  }
  if (!message.includes(' wants you to sign in with your Ethereum account:\n')) {
    refuse('MESSAGE_NOT_ALLOWED', 'only the two MineSwap game-login messages are ever signed');
  }

  const parsed = (() => { try { return parseSiweMessage(message); } catch { return null; } })();
  if (!parsed) refuse('MESSAGE_NOT_ALLOWED', 'the sign-in message does not parse');
  const p = parsed!;
  if (p.domain !== GAME_HOST) refuse('MESSAGE_NOT_ALLOWED', `the sign-in message is for ${JSON.stringify(String(p.domain).slice(0, 60))}, not ${GAME_HOST}`);
  if (!p.address || !sameAddress(p.address, ctx.self)) refuse('MESSAGE_NOT_ALLOWED', 'the sign-in message names another wallet');
  if (p.chainId !== BASE_CHAIN_ID) refuse('MESSAGE_NOT_ALLOWED', 'the sign-in message is not for Base (8453)');
  if (!p.nonce || !NONCE.test(p.nonce)) refuse('MESSAGE_NOT_ALLOWED', 'the sign-in nonce is not alphanumeric');
  if (!(p.issuedAt instanceof Date)) refuse('MESSAGE_NOT_ALLOWED', 'the sign-in message has no issue time');
  const timestamp = p.issuedAt!.getTime();
  if (!Number.isSafeInteger(timestamp) || Math.abs(ctx.nowMs - timestamp) > LOGIN_TTL_MS) {
    refuse('MESSAGE_NOT_ALLOWED', 'the sign-in message is outside the 5-minute window');
  }

  for (const action of ['create', 'takeover'] as const) {
    if (p.statement === sessionStatement(action)) {
      if (message !== buildSessionMessage({ wallet: ctx.self, action, timestamp, nonce: p.nonce! })) {
        refuse('MESSAGE_NOT_ALLOWED', 'the play-session message is not the exact format the kit builds');
      }
      return { kind: 'session', action, timestamp };
    }
  }

  if (ctx.mineId === null) refuse('MESSAGE_NOT_ALLOWED', 'this wallet has no Gold Mine, so there is no war session to sign in to');
  const expected = buildWarAuthMessage({ wallet: ctx.self, tokenId: ctx.mineId!, timestamp, nonce: p.nonce! });
  if (message !== expected) refuse('MESSAGE_NOT_ALLOWED', `the sign-in message is not the exact war-auth challenge for goldmine #${ctx.mineId}`);
  return { kind: 'war-auth', tokenId: ctx.mineId!, timestamp };
}
