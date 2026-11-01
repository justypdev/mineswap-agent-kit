/**
 * Something the user must know happened AFTER the kit decided to sign: a transaction that reverted,
 * a send the signer refused, a receipt that never came, a swap that delivered less than its floor,
 * an approval that could not be revoked, a mine that did not show up.
 *
 * Unlike a GuardRefusal ("nothing was signed"), an incident may have cost gas or left state behind,
 * so it reaches the agent as a WARNING with a fixed, kit-written sentence. Its facts are only values
 * the kit itself holds (pinned addresses, its own transaction hashes, amounts, stable codes), each
 * shape-checked, so no server or revert text can ride along.
 */
export type IncidentCode =
  | 'SEND_FAILED'
  | 'TX_REVERTED'
  | 'RECEIPT_UNKNOWN'
  | 'RECEIVED_BELOW_FLOOR'
  | 'APPROVAL_NOT_REVOKED'
  | 'MINE_NOT_VISIBLE';

type Facts = Readonly<Record<string, string>>;

const FACT = /^(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64}|[0-9]{1,78}|[A-Za-z][A-Za-z0-9_]{0,59})$/;
const clean = (facts: Record<string, unknown>): Facts =>
  Object.freeze(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, typeof v === 'string' && FACT.test(v) ? v : (typeof v === 'bigint' || typeof v === 'number') && FACT.test(String(v)) ? String(v) : '?'])));

const SENTENCE: Record<IncidentCode, (f: Facts) => string> = {
  SEND_FAILED: (f) => `the signer did not send the ${f.step} transaction (${f.kind}). If the CDP wallet policy rejected it, nothing was sent; otherwise check the wallet's recent transactions before retrying`,
  TX_REVERTED: (f) => `the ${f.step} transaction ${f.hash} was sent and reverted on chain: it cost gas and moved no tokens`,
  RECEIPT_UNKNOWN: (f) => `the ${f.step} transaction ${f.hash} was sent but no receipt arrived in time: it may still land. Check it before retrying, or the step may run twice`,
  RECEIVED_BELOW_FLOOR: (f) => `swap ${f.hash} landed but the wallet received ${f.received} of ${f.token}, below the swap's floor ${f.floor}. Stop trading and check the token and the router`,
  APPROVAL_NOT_REVOKED: (f) => `the approval of ${f.token} to ${f.spender} is still in place (${f.after}) and the kit could not revoke it. Revoke it by hand (approve ${f.spender} for 0 on ${f.token}) before anything else`,
  MINE_NOT_VISIBLE: (f) => `activate ${f.hash} landed but the Gold Mine NFT reports no mine for this wallet yet. Check the transaction before calling activate_mine again`,
};

export class KitIncident extends Error {
  readonly code: IncidentCode;
  readonly facts: Facts;
  constructor(code: IncidentCode, facts: Record<string, unknown>) {
    const f = clean(facts);
    super(SENTENCE[code](f));
    this.name = 'KitIncident';
    this.code = code;
    this.facts = f;
  }
}

export const isKitIncident = (e: unknown): e is KitIncident => e instanceof KitIncident;

/** A stable label for the step that failed first, for APPROVAL_NOT_REVOKED's `after`. */
export function failureLabel(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code)) return code;
  return 'SEND_FAILED';
}
