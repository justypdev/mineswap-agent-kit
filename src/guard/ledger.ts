/**
 * The spend ledger behind the 24-hour USD cap.
 *
 * - ROLLING WINDOW: the cap counts every spend in the last 24 hours, not since UTC midnight (a
 *   midnight boundary would let twice the cap through in a few minutes).
 * - ATOMIC, ACROSS PROCESSES: `reserveWithin` takes an exclusive lock file, re-reads the ledger,
 *   checks both caps and appends the spend before releasing it, so two kits (or two MCP clients)
 *   on one ledger cannot both pass the same check. A crashed holder's lock is broken race-free
 *   (breakStaleLock).
 * - FAIL CLOSED: a ledger that cannot be read refuses every swap. A HIGH-WATER SENTINEL kept in a
 *   different directory records the all-time total and the creation time; if the ledger vanishes
 *   after it was created, or comes back with a lower total (restored from an old copy), every swap is
 *   refused until a person resets both files on purpose (README, "Resetting the spend ledger").
 * - A spend is RESERVED before the transaction is sent and is not released if the send fails, so the
 *   cap errs toward spending less.
 *
 * Refusals never name a file path: they reach the agent through MCP, and a path names the user.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Address } from 'viem';
import { checkCaps, type Limits } from './policy.js';
import { refuse } from './refusal.js';

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SpendLedger {
  /** Cents spent by `wallet` in the 24 hours before `nowMs`. */
  spentInWindow(wallet: Address, nowMs: number): bigint;
  /** Atomically: check the per-transaction and 24-hour caps for `cents`, then record it. Throws a GuardRefusal. */
  reserveWithin(wallet: Address, cents: bigint, limits: Limits, nowMs: number): void;
}

type Entry = [timeMs: number, cents: string];

export class MemoryLedger implements SpendLedger {
  private readonly entries = new Map<string, Array<[number, bigint]>>();
  spentInWindow(wallet: Address, nowMs: number): bigint {
    return (this.entries.get(wallet.toLowerCase()) ?? []).filter(([t]) => nowMs - t < WINDOW_MS).reduce((s, [, c]) => s + c, 0n);
  }
  reserveWithin(wallet: Address, cents: bigint, limits: Limits, nowMs: number): void {
    checkCaps(cents, this.spentInWindow(wallet, nowMs), limits);
    const k = wallet.toLowerCase();
    this.entries.set(k, [...(this.entries.get(k) ?? []), [nowMs, cents]]);
  }
}

interface LedgerFile {
  version: 2;
  createdMs: number;
  /** All-time total (cents, decimal string): the high-water mark the sentinel mirrors. */
  totalCents: string;
  /** wallet (lowercase) → [timeMs, cents][] within the last 48 hours */
  spend: Record<string, Entry[]>;
}

interface SentinelFile {
  version: 1;
  createdMs: number;
  totalCents: string;
}

const LEDGER_GONE = 'the spend ledger is unreadable, missing after it was created, or older than its high-water mark; every swap is refused until it is reset on purpose (see the kit README)';
const DIGITS = /^[0-9]{1,30}$/;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A lock this old whose holder process is gone was left by a crash. */
export const STALE_LOCK_MS = 30_000;

/** Whether the process named in a lock file still exists (EPERM: it exists, as another user). */
function holderAlive(lock: string): boolean {
  let pid: number;
  try { pid = Number.parseInt(readFileSync(lock, 'utf8').split(' ')[0] ?? '', 10); } catch { return false; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return false; // empty or torn: judged by age alone
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

const isStale = (st: { mtimeMs: number }, lock: string, nowMs: number): boolean => nowMs - st.mtimeMs > STALE_LOCK_MS && !holderAlive(lock);

/**
 * Remove `lock` if (and only if) it is the stale file observed, re-checked under an exclusive break
 * marker. Returns true when the caller should retry taking the lock right away. Exported for tests;
 * `observed` lets a test simulate the lock being replaced between the first check and the break.
 */
export function breakStaleLock(lock: string, nowMs: () => number = Date.now, observed?: { dev: number; ino: number; mtimeMs: number }): boolean {
  let first: { dev: number; ino: number; mtimeMs: number };
  try { first = observed ?? statSync(lock); } catch { return true; } // released meanwhile: retry
  if (!isStale(first, lock, nowMs())) return false;
  const marker = `${lock}.break`;
  let mfd: number;
  try {
    mfd = openSync(marker, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return refuse('LEDGER_UNAVAILABLE', 'the spend ledger lock cannot be taken');
    let age = 0;
    try { age = nowMs() - statSync(marker).mtimeMs; } catch { return true; }
    if (age > STALE_LOCK_MS) {
      return refuse('LEDGER_UNAVAILABLE', 'a crashed process left the spend ledger\'s lock-break marker behind; stop every kit and remove it (see the kit README, "Resetting the spend ledger")');
    }
    return false; // another process is breaking it now: wait
  }
  try {
    let now: { dev: number; ino: number; mtimeMs: number };
    try { now = statSync(lock); } catch { return true; }
    if (now.dev === first.dev && now.ino === first.ino && isStale(now, lock, nowMs())) unlinkSync(lock);
    return true;
  } finally {
    closeSync(mfd);
    try { unlinkSync(marker); } catch { /* already gone */ }
  }
}

export class FileLedger implements SpendLedger {
  /**
   * @param path      the ledger (JSON, mode 0600)
   * @param sentinel  the high-water mark, in a DIFFERENT directory from the ledger
   */
  constructor(private readonly path: string, private readonly sentinel: string, private readonly lockTimeoutMs = 5_000) {
    if (dirname(path) === dirname(sentinel)) throw new Error('the ledger sentinel must live in a different directory from the ledger');
  }

  private readJson<T>(p: string): T | null {
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    } catch {
      return refuse('LEDGER_UNAVAILABLE', LEDGER_GONE);
    }
  }

  private load(): LedgerFile {
    const sentinel = this.readJson<SentinelFile>(this.sentinel);
    const ledger = this.readJson<LedgerFile>(this.path);
    if (sentinel && (sentinel.version !== 1 || !DIGITS.test(String(sentinel.totalCents)))) refuse('LEDGER_UNAVAILABLE', LEDGER_GONE);
    if (!ledger) {
      if (sentinel) refuse('LEDGER_UNAVAILABLE', LEDGER_GONE);
      return { version: 2, createdMs: Date.now(), totalCents: '0', spend: {} };
    }
    if (ledger.version !== 2 || typeof ledger.spend !== 'object' || ledger.spend === null || !DIGITS.test(String(ledger.totalCents))) {
      refuse('LEDGER_UNAVAILABLE', LEDGER_GONE);
    }
    for (const entries of Object.values(ledger.spend)) {
      if (!Array.isArray(entries)) refuse('LEDGER_UNAVAILABLE', LEDGER_GONE);
      for (const e of entries) {
        if (!Array.isArray(e) || typeof e[0] !== 'number' || !Number.isFinite(e[0]) || typeof e[1] !== 'string' || !DIGITS.test(e[1])) refuse('LEDGER_UNAVAILABLE', LEDGER_GONE);
      }
    }
    if (!sentinel) refuse('LEDGER_UNAVAILABLE', LEDGER_GONE); // a ledger without its sentinel was tampered with
    if (BigInt(ledger.totalCents) < BigInt(sentinel!.totalCents)) refuse('LEDGER_UNAVAILABLE', LEDGER_GONE);
    return ledger;
  }

  private window(f: LedgerFile, wallet: Address, nowMs: number): bigint {
    return (f.spend[wallet.toLowerCase()] ?? []).filter(([t]) => nowMs - t < WINDOW_MS).reduce((s, [, c]) => s + BigInt(c), 0n);
  }

  spentInWindow(wallet: Address, nowMs: number): bigint {
    return this.window(this.load(), wallet, nowMs);
  }

  private writeAtomic(p: string, value: unknown): void {
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, p);
  }

  /**
   * An exclusive lock file next to the ledger (O_EXCL create), holding "<pid> <ms>". A lock is STALE
   * only when it is older than STALE_LOCK_MS AND its holder process no longer exists. Breaking one
   * is itself exclusive: the breaker first O_EXCL-creates `<lock>.break`, then re-checks UNDER it that
   * the lock is the very file it judged stale (same device and inode), still stale, holder still gone,
   * and only then unlinks it. Two processes can therefore never both break a lock, and a fresh lock
   * that replaced the stale one is never removed. A break marker left by a crash (it lives for
   * microseconds) fails closed: every swap is refused until a person removes it (README).
   */
  private withLock<T>(f: () => T): T {
    const lock = `${this.path}.lock`;
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + this.lockTimeoutMs;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(lock, 'wx', 0o600);
        writeSync(fd, `${process.pid} ${Date.now()}\n`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return refuse('LEDGER_UNAVAILABLE', 'the spend ledger lock cannot be taken');
        if (breakStaleLock(lock)) continue;
        if (Date.now() > deadline) return refuse('LEDGER_UNAVAILABLE', 'the spend ledger is locked by another process; try again');
        sleepSync(25);
      }
    }
    try {
      return f();
    } finally {
      closeSync(fd);
      try { unlinkSync(lock); } catch { /* already gone */ }
    }
  }

  reserveWithin(wallet: Address, cents: bigint, limits: Limits, nowMs: number): void {
    this.withLock(() => {
      const f = this.load();
      checkCaps(cents, this.window(f, wallet, nowMs), limits);
      const w = wallet.toLowerCase();
      // Keep 48 h per wallet; the cap reads 24.
      f.spend[w] = [...(f.spend[w] ?? []).filter(([t]) => nowMs - t < 2 * WINDOW_MS), [nowMs, cents.toString()]];
      f.totalCents = (BigInt(f.totalCents) + cents).toString();
      // Ledger first, then the sentinel: a crash between them leaves ledger ≥ sentinel, which loads.
      this.writeAtomic(this.path, f);
      this.writeAtomic(this.sentinel, { version: 1, createdMs: f.createdMs, totalCents: f.totalCents } satisfies SentinelFile);
    });
  }
}
