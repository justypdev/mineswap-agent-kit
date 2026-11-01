/**
 * Projection helpers: everything the kit returns to the LLM is a typed, bounded field it picked out
 * itself. Server text (an error sentence, a message, a status string) never passes through: a
 * hostile or compromised server could otherwise put instructions in front of the agent.
 */
export const num = (v: unknown, max = 1e24): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= max ? v : null);
export const int = (v: unknown, max = Number.MAX_SAFE_INTEGER): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= max ? v : null);
export const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
export const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null);
/** An identifier: letters, digits, '_' and '-', at most 64. */
export const ident = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
/** A plain decimal amount such as "1.2345". */
export const decimal = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,30}(\.\d{1,30})?$/.test(v) ? v : null);
/** A base-unit integer as a decimal string. */
export const uintStr = (v: unknown): string | null => (typeof v === 'string' && /^\d{1,78}$/.test(v) ? v : null);
/** An error code such as SAVE_BUSY. */
export const errCode = (v: unknown): string | null => (typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(v) ? v : null);
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const list = (v: unknown, max = 50): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
