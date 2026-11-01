import { describe, expect, it } from 'vitest';
import { HttpClient, HttpError, RateLimitedError, retryAfterMs } from '../src/http.js';

function script(responses: Array<() => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let i = 0;
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return r();
  };
  return { fetch, calls };
}

const j = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept };
}

describe('429 back-off', () => {
  it('honours Retry-After seconds (mineswap.org answers 60) and then succeeds', async () => {
    const c = clock();
    const s = script([j(429, { error: 'Rate limit exceeded. Please try again later.' }, { 'retry-after': '60' }), j(200, { ok: true })]);
    const h = new HttpClient({ fetch: s.fetch, sleep: c.sleep, now: c.now });
    const r = await h.requestJson('https://mineswap.org/api/quote?x=1');
    expect(r.status).toBe(200);
    expect(c.slept).toEqual([60_000]);
    expect(s.calls).toHaveLength(2);
  });

  it('honours an HTTP-date Retry-After and a JSON retryAfter', () => {
    const now = Date.parse('2026-10-31T14:00:00Z');
    expect(retryAfterMs(new Response('', { headers: { 'retry-after': 'Sat, 31 Oct 2026 14:00:30 GMT' } }), null, now)).toBe(30_000);
    expect(retryAfterMs(new Response('', {}), { retryAfter: 7 }, now)).toBe(7_000);
    expect(retryAfterMs(new Response('', {}), null, now)).toBeNull();
  });

  it('backs off exponentially when no Retry-After is given, then gives up with RateLimitedError', async () => {
    const c = clock();
    const s = script([j(429, {})]);
    const h = new HttpClient({ fetch: s.fetch, sleep: c.sleep, now: c.now, baseDelayMs: 1_000, maxRetries: 3 });
    await expect(h.requestJson('https://mineswap.org/api/quote')).rejects.toBeInstanceOf(RateLimitedError);
    expect(c.slept).toEqual([1_000, 2_000, 4_000]);
    expect(s.calls).toHaveLength(4);
  });

  it('refuses to wait longer than maxWaitMs', async () => {
    const c = clock();
    const s = script([j(429, {}, { 'retry-after': '3600' })]);
    const h = new HttpClient({ fetch: s.fetch, sleep: c.sleep, now: c.now });
    await expect(h.requestJson('https://mineswap.org/api/quote')).rejects.toThrow(/retry after 3600 s/);
    expect(c.slept).toEqual([]);
  });

  it('retries a 503 only when it carries Retry-After; other errors are returned, not retried', async () => {
    const c = clock();
    const s = script([j(503, { code: 'upstream' }, { 'retry-after': '2' }), j(422, { ok: false, code: 'no_route' })]);
    const h = new HttpClient({ fetch: s.fetch, sleep: c.sleep, now: c.now });
    const r = await h.requestJson('https://mineswap.org/api/quote');
    expect(r.status).toBe(422);
    expect(c.slept).toEqual([2_000]);
  });
});

describe('client-side budget and transport rules', () => {
  it('never sends more than maxPerMinute requests in a rolling minute', async () => {
    const c = clock();
    const s = script([j(200, { ok: true })]);
    const h = new HttpClient({ fetch: s.fetch, sleep: c.sleep, now: c.now, maxPerMinute: 20 });
    for (let k = 0; k < 21; k++) await h.requestJson('https://mineswap.org/api/quote');
    expect(s.calls).toHaveLength(21);
    expect(c.slept).toHaveLength(1);
    expect(c.slept[0]).toBeGreaterThanOrEqual(60_000);
  });

  it('never follows a redirect', async () => {
    const s = script([() => new Response(null, { status: 307, headers: { location: 'https://evil.example/api/war-auth' } })]);
    const h = new HttpClient({ fetch: s.fetch });
    await expect(h.requestJson('https://www.mineswap.app/api/war-auth', { method: 'POST' })).rejects.toBeInstanceOf(HttpError);
    expect(s.calls[0]!.init!.redirect).toBe('manual');
  });
});

describe('L-3: the response body is bounded in bytes and time while it streams', () => {
  const stream = (chunks: number, chunkBytes: number, delayMs = 0) => () => new Response(new ReadableStream<Uint8Array>({
    async start(c) {
      for (let i = 0; i < chunks; i++) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        c.enqueue(new Uint8Array(chunkBytes).fill(0x20));
      }
      c.close();
    },
  }), { status: 200 });

  it('stops reading once the body passes maxBodyBytes (it never buffers the whole thing)', async () => {
    let pulled = 0;
    const endless = () => new Response(new ReadableStream<Uint8Array>({
      pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); },
    }), { status: 200 });
    const h = new HttpClient({ fetch: script([endless]).fetch, maxBodyBytes: 256 * 1024 });
    await expect(h.requestJson('https://mineswap.org/api/quote')).rejects.toMatchObject({ message: expect.stringMatching(/too large/) });
    expect(pulled).toBeLessThan(10);
  });

  it('accepts a body under the cap', async () => {
    const h = new HttpClient({ fetch: script([stream(4, 1024)]).fetch, maxBodyBytes: 8 * 1024 });
    await expect(h.requestJson('https://mineswap.org/api/quote')).resolves.toMatchObject({ status: 200, body: null });
  });

  it('one deadline covers headers AND body: a body that trickles in is cut off', async () => {
    const h = new HttpClient({ fetch: script([stream(50, 10, 20)]).fetch, timeoutMs: 100 });
    await expect(h.requestJson('https://mineswap.org/api/quote')).rejects.toMatchObject({ message: expect.stringMatching(/timed out/) });
  });

  it('a fetch that never answers times out as HttpError(0) naming only the host', async () => {
    const hang = (_u: string, i?: RequestInit) => new Promise<Response>((_, rej) => i?.signal?.addEventListener('abort', () => rej(new Error('aborted at https://x.example/?key=SECRET'))));
    const h = new HttpClient({ fetch: hang, timeoutMs: 50 });
    const e = (await h.requestJson('https://mineswap.org/api/quote?k=1').catch((x) => x)) as HttpError;
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(0);
    expect(e.message).toBe('mineswap.org timed out');
  });
});
