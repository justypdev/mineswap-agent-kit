/**
 * The kit's HTTP client: a client-side request budget, 429 back-off that honours Retry-After, no
 * redirects (a redirect could move a login to another host), and a response-size bound.
 *
 * mineswap.org rate-limits /api/quote to 30 requests per minute per IP and answers 429 with
 * `Retry-After: 60`. The kit spends at most `maxPerMinute` (default 20) so a well-behaved agent
 * never meets the server's limit, and when it does it waits as told instead of hammering.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly fetch?: FetchLike;
  /** Client-side budget per rolling minute. */
  readonly maxPerMinute?: number;
  /** Retries after a 429 (or a 503 that carries Retry-After). */
  readonly maxRetries?: number;
  /** First back-off when the server names no Retry-After, doubled per retry. */
  readonly baseDelayMs?: number;
  /** Longest single wait the client accepts before giving up with a RateLimited error. */
  readonly maxWaitMs?: number;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class RateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(url: string, retryAfterMs: number) {
    super(`rate limited by ${new URL(url).host}; retry after ${Math.ceil(retryAfterMs / 1000)} s`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** Retry-After as seconds or an HTTP date; a JSON `retryAfter` (seconds) as the fallback. */
export function retryAfterMs(res: Response, body: unknown, nowMs: number): number | null {
  const h = res.headers.get('retry-after');
  if (h) {
    if (/^\d{1,6}$/.test(h.trim())) return Number(h.trim()) * 1000;
    const at = Date.parse(h);
    if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  }
  const b = body as { retryAfter?: unknown } | null;
  if (b && typeof b.retryAfter === 'number' && Number.isFinite(b.retryAfter) && b.retryAfter >= 0) return b.retryAfter * 1000;
  return null;
}

export class HttpClient {
  readonly #fetch: FetchLike;
  readonly #maxPerMinute: number;
  readonly #maxRetries: number;
  readonly #baseDelayMs: number;
  readonly #maxWaitMs: number;
  readonly #timeoutMs: number;
  readonly #maxBodyBytes: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #sent: number[] = [];

  constructor(o: HttpOptions = {}) {
    this.#fetch = o.fetch ?? ((u, i) => fetch(u, i));
    this.#maxPerMinute = o.maxPerMinute ?? 20;
    this.#maxRetries = o.maxRetries ?? 3;
    this.#baseDelayMs = o.baseDelayMs ?? 2_000;
    this.#maxWaitMs = o.maxWaitMs ?? 120_000;
    this.#timeoutMs = o.timeoutMs ?? 30_000;
    this.#maxBodyBytes = o.maxBodyBytes ?? 1_000_000;
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = o.now ?? Date.now;
  }

  /** Wait until one more request fits the rolling one-minute budget. */
  async #budget(): Promise<void> {
    for (;;) {
      const now = this.#now();
      while (this.#sent.length && now - this.#sent[0]! >= 60_000) this.#sent.shift();
      if (this.#sent.length < this.#maxPerMinute) {
        this.#sent.push(now);
        return;
      }
      await this.#sleep(60_000 - (now - this.#sent[0]!) + 5);
    }
  }

  /** Read at most maxBodyBytes of the body; the request's one deadline covers the whole read. */
  async #readBounded(res: Response, signal: AbortSignal): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const onAbort = () => { void reader.cancel().catch(() => undefined); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw new HttpError(res.status, 'response body timed out', null);
        const { done, value } = await reader.read();
        // A cancel on timeout ends a pending read as `done`: that is a truncated body, not the end of one.
        if (signal.aborted) throw new HttpError(res.status, 'response body timed out', null);
        if (done) break;
        size += value.byteLength;
        if (size > this.#maxBodyBytes) {
          await reader.cancel().catch(() => undefined);
          throw new HttpError(res.status, 'response body too large', null);
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(res.status, signal.aborted ? 'response body timed out' : 'response body could not be read', null);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) { all.set(c, at); at += c.byteLength; }
    return new TextDecoder().decode(all);
  }

  async requestJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; headers: Headers }> {
    for (let attempt = 0; ; attempt++) {
      await this.#budget();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.#timeoutMs);
      let res: Response;
      let text: string;
      try {
        try {
          res = await this.#fetch(url, { ...init, redirect: 'manual', signal: ctrl.signal });
        } catch {
          throw new HttpError(0, ctrl.signal.aborted ? `${new URL(url).host} timed out` : `${new URL(url).host} could not be reached`, null);
        }
        if (res.status >= 300 && res.status < 400) {
          throw new HttpError(res.status, `${new URL(url).host} answered a redirect; the kit never follows redirects`, null);
        }
        text = await this.#readBounded(res, ctrl.signal);
      } finally {
        clearTimeout(timer);
      }
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      const wait = retryAfterMs(res, body, this.#now());
      const retriable = res.status === 429 || (res.status === 503 && wait !== null);
      if (!retriable) return { status: res.status, body, headers: res.headers };
      const delay = wait ?? this.#baseDelayMs * 2 ** attempt;
      if (attempt >= this.#maxRetries || delay > this.#maxWaitMs) throw new RateLimitedError(url, delay);
      await this.#sleep(delay);
    }
  }
}
