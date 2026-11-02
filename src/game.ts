/**
 * mineswap.app's game API, as its route handlers implement it:
 *
 *   POST /api/war-auth   { wallet, tokenId, mineType: 'goldmine', signature, message, timestamp }
 *                        → { success, token, nonce, tokenId, mineType, expiresIn: 86400 }
 *                        `message` is the exact SIWE challenge (guard/messages.ts); the server
 *                        re-checks the host, chain, expiry and ownerOf, and consumes the signature.
 *   GET  /api/agent/state[?include=smelter]                       Authorization: Bearer <token>
 *   POST /api/agent/mine        { clicks }      ≤ 12 calls/min, ≥ 5 s apart
 *   POST /api/agent/upgrade     { upgradeId, count ≤ 10 }
 *   POST /api/agent/expedition  { action: 'start' | 'claim' | 'status', type?: shallow|deep|legendary }
 *                               under the new rules (`rules: 'rng1'`) a start TAKES scouts — shallow 10, deep
 *                               20, legendary 30 — away for the whole trip (409 SCOUTS { need, have }
 *                               when the mine has too few at home); the claim succeeds or fails on the
 *                               server's roll: success brings them all home, failure pays half the gold
 *                               and loses half the scouts (5 / 10 / 15).
 *   POST /api/agent/claim       { action: 'status' | 'claim' | 'history', batchId?, hmac? }
 *                               a claim queues BG for the admin payout to the mine's owner wallet.
 *
 * WHY `login` DOES NOT CALL /api/session: every /api/agent write route refuses with 409
 * `sessionConflict` for 60 s after an /api/session heartbeat, so creating one would block the
 * agent's own mining. The agent API authenticates with the war-auth bearer alone.
 * `createPlaySession()` is kept, signed through the same allowlist (the domain-bound SIWE play-
 * session message), for a caller that deliberately wants the browser play-session lock.
 *
 * WHAT REACHES THE AGENT: typed fields this client picks out of each response (sanitize.ts), never
 * the server's text. An error is its HTTP status, a validated error code and a sentence the KIT
 * wrote. The bearer token lives in memory only.
 */
import { generateSiweNonce } from 'viem/siwe';
import { buildSessionMessage, buildWarAuthMessage, type SessionAction } from './guard/messages.js';
import { refuse } from './guard/refusal.js';
import type { GuardedWallet } from './guard/wallet.js';
import { HttpClient } from './http.js';
import { GAME_ORIGIN } from './pins.js';
import { bool, decimal, errCode, ident, int, list, num, oneOf, rec, uintStr } from './sanitize.js';

export const UPGRADE_IDS = [
  'pickaxe', 'miner', 'drill', 'excavator', 'dynamite', 'goldmine', 'luckyStrike', 'goldBoost', 'geologist',
  'deepShaft', 'refinery', 'tunnelBorer', 'motherLode', 'quantumDrill', 'voidExtractor', 'cosmicForge',
] as const;
export type UpgradeId = (typeof UPGRADE_IDS)[number];
export const EXPEDITION_TYPES = ['shallow', 'deep', 'legendary'] as const;
export type ExpeditionType = (typeof EXPEDITION_TYPES)[number];

/** The server's own floor between mine calls. */
export const MIN_MINE_INTERVAL_MS = 5_000;

const STATUS_SENTENCE: Readonly<Record<number, string>> = Object.freeze({
  400: 'mineswap.app refused the request as invalid',
  401: 'the mineswap.app session expired or was refused; call login again',
  403: 'mineswap.app refused access for this wallet',
  404: 'mineswap.app has no such record yet (call state first)',
  409: 'the mine is busy: a browser tab played it in the last 2 minutes, or a play session is open; wait and retry',
  429: 'mineswap.app is rate limiting this client; wait before retrying',
  500: 'mineswap.app hit an internal error',
  502: 'mineswap.app answered without what the kit needs',
  503: 'mineswap.app is temporarily unavailable; retry shortly',
});

/** Refusals the kit explains in its own words (typed numbers only, never the server's text). */
function codeSentence(code: string | null, b: Record<string, unknown>): string | null {
  if (code === 'SCOUTS') {
    const need = int(b.need, 1_000_000);
    const have = int(b.have, Number.MAX_SAFE_INTEGER);
    return `the expedition takes ${need ?? 'more'} scouts and the mine has ${have ?? 'fewer'} at home; train scouts first (100K gold each, 1 minute)`;
  }
  return null;
}

export class GameApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly retryAfterS: number | null;
  /** SCOUTS: the scouts the expedition takes, and those at home. */
  readonly need: number | null;
  readonly have: number | null;
  constructor(status: number, body: unknown) {
    const b = rec(body);
    const code = errCode(b.code);
    const sentence = codeSentence(code, b) ?? STATUS_SENTENCE[status] ?? `mineswap.app answered HTTP ${status}`;
    super(`${sentence} (HTTP ${status}${code ? `, ${code}` : ''})`);
    this.name = 'GameApiError';
    this.status = status;
    this.code = code;
    this.retryAfterS = int(b.retryAfter, 86_400);
    this.need = int(b.need, 1_000_000);
    this.have = int(b.have, Number.MAX_SAFE_INTEGER);
  }
}

export interface GameClientOptions {
  readonly origin?: string;
  readonly now?: () => number;
  readonly nonce?: () => string;
  readonly sleep?: (ms: number) => Promise<void>;
}

// ── projections ─────────────────────────────────────────────────────────────────────────────

const pick = <K extends string>(o: Record<string, unknown>, keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, num(o[k])])) as Record<K, number | null>;

export function projectState(body: unknown) {
  const b = rec(body);
  const s = rec(b.state);
  const ups = rec(s.upgrades);
  const exp = rec(s.activeExpedition);
  const smelter = b.smelter === undefined ? undefined : rec(b.smelter);
  return {
    tokenId: int(b.tokenId),
    initialized: b.initialized === true,
    ...pick(s, ['gold', 'totalGoldEarned', 'totalClicks', 'level', 'goldPerSecond', 'goldPerClick', 'boostMultiplier', 'completedExpeditions', 'activeRaids', 'wallHP']),
    upgrades: Object.fromEntries(UPGRADE_IDS.map((id) => {
      const u = rec(ups[id]);
      return [id, { owned: int(u.owned), maxOwned: int(u.maxOwned), nextCost: num(u.nextCost) }];
    })),
    activeExpedition: s.activeExpedition ? { type: oneOf(exp.expeditionId ?? exp.type, EXPEDITION_TYPES), endTime: int(exp.endTime) } : null,
    ...(smelter ? { smelter: { unsmeltedBG: decimal(smelter.unsmeltedBG), smeltedBG: decimal(smelter.smeltedBG), activeBatches: int(smelter.activeBatches) } } : {}),
  };
}

export function projectMine(body: unknown) {
  return pick(rec(body), ['clicks', 'goldEarned', 'clickGold', 'passiveGold', 'gold', 'totalGoldEarned', 'level', 'goldPerSecond', 'goldPerClick']);
}

export function projectUpgrade(body: unknown) {
  const b = rec(body);
  return { upgrade: oneOf(b.upgrade, UPGRADE_IDS), ...pick(b, ['purchased', 'totalCost', 'newOwned', 'maxOwned', 'gold', 'goldPerSecond', 'nextCost', 'level']) };
}

/** The new expedition rules: a trip stamped with them succeeds or fails on the server's roll. */
export const EXPEDITION_RULES = ['rng1'] as const;
export const EXPEDITION_RESULTS = ['success', 'failure'] as const;
/** Set on an outcome paid the classic way (no roll, no scouts lost) under the server's kill switch. */
export const EXPEDITION_PAID_AS = ['classic-kill-switch'] as const;

export function projectExpedition(body: unknown) {
  const b = rec(body);
  const e = b.expedition ? rec(b.expedition) : null;
  const r = b.reward ? rec(b.reward) : null;
  // The outcome of a claim under the new rules: typed fields only (the server's story text never reaches the agent).
  const o = b.outcome ? rec(b.outcome) : null;
  return {
    expedition: e ? {
      type: oneOf(e.type, EXPEDITION_TYPES), startTime: int(e.startTime), endTime: int(e.endTime), durationMs: int(e.durationMs), isComplete: bool(e.isComplete), remainingMs: int(e.remainingMs),
      ...(e.rules !== undefined ? { rules: oneOf(e.rules, EXPEDITION_RULES), scoutsCommitted: int(e.scoutsCommitted) } : {}),
    } : null,
    ...(r ? { reward: { type: oneOf(r.type, EXPEDITION_TYPES), ...pick(r, ['passiveGold', 'bonusGold', 'totalReward']) } } : {}),
    ...(o ? { outcome: {
      result: oneOf(o.result, EXPEDITION_RESULTS), storyId: ident(o.storyId),
      scoutsCommitted: int(o.scoutsCommitted), scoutsLost: int(o.scoutsLost), scoutsReturned: int(o.scoutsReturned),
      gpsBonus: int(o.gpsBonus), boostMultiplier: num(o.boostMultiplier, 100),
      ...(o.paidAs !== undefined ? { paidAs: oneOf(o.paidAs, EXPEDITION_PAID_AS) } : {}),
    } } : {}),
    ...(b.rules !== undefined ? { rules: oneOf(b.rules, EXPEDITION_RULES) } : {}),
    ...pick(b, ['gold', 'totalGoldEarned', 'completedExpeditions', 'level']),
  };
}

export function projectClaimStatus(body: unknown) {
  const b = rec(body);
  return {
    claimable: list(b.claimable).map((x) => { const c = rec(x); return { batchId: ident(c.batchId), bg: decimal(c.bg), completedAt: int(c.completedAt) }; }),
    smelting: list(b.smelting).map((x) => { const c = rec(x); return { batchId: ident(c.batchId), bg: decimal(c.bg), completeTime: int(c.completeTime), remainingMs: int(c.remainingMs) }; }),
    totalClaimableBG: decimal(b.totalClaimableBG),
  };
}

export function projectClaimHistory(body: unknown) {
  const b = rec(body);
  return {
    total: int(b.total),
    claims: list(b.claims, 20).map((x) => { const c = rec(x); return { batchId: ident(c.batchId), bg: decimal(c.bg), bgWei: uintStr(c.bgWei), claimedAt: int(c.claimedAt), status: oneOf(c.status, ['queued', 'paid', 'failed'] as const) }; }),
  };
}

export class GameClient {
  #token: string | null = null;
  #tokenId: number | null = null;
  #lastMineAt = 0;
  readonly #origin: string;
  readonly #now: () => number;
  readonly #nonce: () => string;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(private readonly http: HttpClient, private readonly wallet: GuardedWallet, o: GameClientOptions = {}) {
    this.#origin = o.origin ?? GAME_ORIGIN;
    this.#now = o.now ?? Date.now;
    this.#nonce = o.nonce ?? (() => generateSiweNonce());
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get loggedIn(): boolean { return this.#token !== null; }

  async #post(path: string, body: unknown, auth: boolean): Promise<unknown> {
    if (auth && !this.#token) refuse('INVALID_ARGUMENT', 'not logged in to mineswap.app; call login first');
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (auth) headers.authorization = `Bearer ${this.#token}`;
    return this.#result(await this.http.requestJson(new URL(path, this.#origin).toString(), { method: 'POST', headers, body: JSON.stringify(body) }));
  }

  async #get(path: string): Promise<unknown> {
    if (!this.#token) refuse('INVALID_ARGUMENT', 'not logged in to mineswap.app; call login first');
    return this.#result(await this.http.requestJson(new URL(path, this.#origin).toString(), { headers: { accept: 'application/json', authorization: `Bearer ${this.#token}` } }));
  }

  #result(r: { status: number; body: unknown }): unknown {
    if (r.status === 401) this.#token = null;
    if (r.status < 200 || r.status >= 300) throw new GameApiError(r.status, r.body);
    return r.body;
  }

  /** War-auth sign-in for this wallet's own Gold Mine (its id is read on chain, never taken from an argument). */
  async login(): Promise<{ tokenId: number; expiresIn: number | null }> {
    const tokenId = await this.wallet.mineId();
    if (tokenId === null) refuse('NO_MINE', 'this wallet has no Gold Mine yet; call activate_mine first');
    const timestamp = this.#now();
    const message = buildWarAuthMessage({ wallet: this.wallet.address, tokenId: tokenId!, timestamp, nonce: this.#nonce() });
    const { signature } = await this.wallet.signLoginMessage(message);
    const body = rec(await this.#post('/api/war-auth', {
      wallet: this.wallet.address, tokenId, mineType: 'goldmine', signature, message, timestamp,
    }, false));
    if (body.success !== true || typeof body.token !== 'string' || body.token.length < 16 || body.token.length > 512) {
      throw new GameApiError(502, { code: 'NO_SESSION_TOKEN' });
    }
    this.#token = body.token;
    this.#tokenId = tokenId!;
    return { tokenId: tokenId!, expiresIn: int(body.expiresIn) };
  }

  /**
   * POST /api/session create / takeover — the browser play-session lock. NOT used by login (see the
   * header): while its heartbeat is fresh, every agent write is refused with 409 for 60 s.
   */
  async createPlaySession(action: SessionAction = 'create', deviceInfo = 'mineswap-agent-kit'): Promise<{ sessionId: string }> {
    if (action !== 'create' && action !== 'takeover') refuse('INVALID_ARGUMENT', 'a play session is create or takeover');
    const timestamp = this.#now();
    const message = buildSessionMessage({ wallet: this.wallet.address, action, timestamp, nonce: this.#nonce() });
    const { signature } = await this.wallet.signLoginMessage(message);
    const body = rec(await this.#post('/api/session', { action, address: this.wallet.address, deviceInfo, signature, message, timestamp }, false));
    if (body.conflict === true) throw new GameApiError(409, { code: 'PLAY_SESSION_CONFLICT' });
    const sessionId = ident(body.sessionId);
    if (!sessionId) throw new GameApiError(502, { code: 'NO_SESSION_ID' });
    return { sessionId };
  }

  async endPlaySession(sessionId: string): Promise<{ ended: boolean }> {
    if (!ident(sessionId)) refuse('INVALID_ARGUMENT', 'not a session id');
    const body = rec(await this.#post('/api/session', { action: 'end', address: this.wallet.address, sessionId }, false));
    return { ended: body.success === true };
  }

  async state(includeSmelter = false) {
    return projectState(await this.#get(`/api/agent/state${includeSmelter ? '?include=smelter' : ''}`));
  }

  async mine(clicks: number) {
    if (!Number.isSafeInteger(clicks) || clicks < 1 || clicks > 10_000) refuse('INVALID_ARGUMENT', 'clicks must be an integer from 1 to 10000');
    const wait = this.#lastMineAt + MIN_MINE_INTERVAL_MS - this.#now();
    if (wait > 0) await this.#sleep(wait);
    this.#lastMineAt = this.#now();
    return projectMine(await this.#post('/api/agent/mine', { clicks }, true));
  }

  async upgrade(upgradeId: UpgradeId, count = 1) {
    if (!(UPGRADE_IDS as readonly string[]).includes(upgradeId)) refuse('INVALID_ARGUMENT', 'unknown upgrade id');
    if (!Number.isSafeInteger(count) || count < 1 || count > 10) refuse('INVALID_ARGUMENT', 'count must be an integer from 1 to 10');
    return projectUpgrade(await this.#post('/api/agent/upgrade', { upgradeId, count }, true));
  }

  async expedition(action: 'start' | 'claim' | 'status', type?: ExpeditionType) {
    if (action === 'start' && (!type || !(EXPEDITION_TYPES as readonly string[]).includes(type))) refuse('INVALID_ARGUMENT', 'start needs a type: shallow, deep or legendary');
    return projectExpedition(await this.#post('/api/agent/expedition', action === 'start' ? { action, type } : { action }, true));
  }

  /**
   * Smelted-BG claims. `claim` never takes a ticket from the caller: it re-reads `status` and
   * submits the server's own HMAC ticket for the batch(es) listed there. The payout goes to the
   * mine owner's wallet, decided by the server; the kit signs nothing here.
   */
  async claim(action: 'status' | 'claim' | 'history', batchId?: string) {
    if (action === 'status') return projectClaimStatus(await this.#post('/api/agent/claim', { action }, true));
    if (action === 'history') return projectClaimHistory(await this.#post('/api/agent/claim', { action }, true));
    const status = rec(await this.#post('/api/agent/claim', { action: 'status' }, true));
    const tickets = list(status.claimable).map(rec)
      .filter((b) => ident(b.batchId) !== null && typeof b.hmac === 'string' && /^[0-9a-fA-F]{16,128}$/.test(b.hmac) && (batchId === undefined || b.batchId === batchId));
    const claimed: Array<{ batchId: string | null; queued: boolean; error?: string }> = [];
    for (const t of tickets.slice(0, 20)) {
      try {
        const r = rec(await this.#post('/api/agent/claim', { action: 'claim', batchId: t.batchId, hmac: t.hmac }, true));
        claimed.push({ batchId: ident(t.batchId), queued: r.success === true });
      } catch (e) {
        claimed.push({ batchId: ident(t.batchId), queued: false, error: e instanceof GameApiError ? e.message : 'the claim request failed' });
      }
    }
    return { claimed };
  }

  get tokenId(): number | null { return this.#tokenId; }
}
