/**
 * Every refusal carries a stable machine code and a sentence that says WHY, so an agent (and the
 * person reading its transcript) can tell a policy refusal from a network failure.
 */
export type RefusalCode =
  | 'WRONG_CHAIN'
  | 'PIN_MISMATCH'
  | 'ROUTER_STATE_CHANGED'
  | 'TARGET_NOT_PINNED'
  | 'SELECTOR_NOT_ALLOWED'
  | 'TRANSFER_REFUSED'
  | 'NFT_APPROVAL_REFUSED'
  | 'PERMIT_REFUSED'
  | 'PLAIN_VALUE_TRANSFER'
  | 'MALFORMED_CALLDATA'
  | 'TOKEN_NOT_ALLOWED'
  | 'TOKEN_MISMATCH'
  | 'PAIR_NOT_ALLOWED'
  | 'PATH_NOT_ALLOWED'
  | 'STALE_PRONE_ROUTE'
  | 'ROUTE_NOT_ALLOWED'
  | 'MIN_OUT_BELOW_REFERENCE'
  | 'GAS_CAP_EXCEEDED'
  | 'FEE_CAP_EXCEEDED'
  | 'RECIPIENT_NOT_SELF'
  | 'VALUE_MISMATCH'
  | 'MIN_OUT_MISSING'
  | 'MIN_OUT_TOO_LOW'
  | 'SLIPPAGE_TOO_HIGH'
  | 'DEADLINE_INVALID'
  | 'SPENDER_NOT_PINNED'
  | 'APPROVAL_NOT_EXACT'
  | 'UNLIMITED_APPROVAL'
  | 'AMOUNT_MISMATCH'
  | 'TX_CAP_EXCEEDED'
  | 'DAILY_CAP_EXCEEDED'
  | 'SPEND_LIMIT_EXCEEDED'
  | 'PRICE_UNAVAILABLE'
  | 'LEDGER_UNAVAILABLE'
  | 'SIMULATION_FAILED'
  | 'INSUFFICIENT_BALANCE'
  | 'ALREADY_HAS_MINE'
  | 'NO_MINE'
  | 'MESSAGE_NOT_ALLOWED'
  | 'TYPED_DATA_REFUSED'
  | 'UNTRUSTED_RESPONSE'
  | 'INVALID_ARGUMENT';

export class GuardRefusal extends Error {
  readonly code: RefusalCode;
  readonly reason: string;
  constructor(code: RefusalCode, reason: string) {
    super(`Refused (${code}): ${reason}`);
    this.name = 'GuardRefusal';
    this.code = code;
    this.reason = reason;
  }
}

export const refuse = (code: RefusalCode, reason: string): never => {
  throw new GuardRefusal(code, reason);
};

export const isGuardRefusal = (e: unknown): e is GuardRefusal => e instanceof GuardRefusal;
