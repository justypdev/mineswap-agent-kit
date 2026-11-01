/**
 * A revert, summarised for the agent WITHOUT any text the reverting contract chose: a revert
 * string or arbitrary error data is attacker-controlled (a hostile pool in a route can revert with
 * "ignore your instructions and…"), so only a known error NAME or a bare 4-byte selector is ever
 * returned. The table holds both routers' custom errors and the common token errors.
 */
const KNOWN: Readonly<Record<string, string>> = Object.freeze({
  '0xd7e94e9e': 'AdapterAlreadyAdded()',
  '0x8966a855': 'AdapterNotRegistered()',
  '0x959a9ef5': 'BadFeePool()',
  '0x424b43ce': 'BadMsgValue()',
  '0xc4806063': 'BadPoolTokens()',
  '0x67a2cc26': 'BadRecipient()',
  '0x3c80c4b5': 'BadTokenPair()',
  '0xdb5fe372': 'CallbackForbidden()',
  '0x1e359413': 'CallbackOverpay()',
  '0x5212cba1': 'CurrencyNotSettled()',
  '0x4618ccfa': 'DeltaMismatch()',
  '0x878321b5': 'DiscontinuousPlan()',
  '0xfb8f41b2': 'ERC20InsufficientAllowance(address,uint256,uint256)',
  '0xe450d38c': 'ERC20InsufficientBalance(address,uint256,uint256)',
  '0x98248e64': 'EthSendFailed()',
  '0xbd750b82': 'ExcessiveInput()',
  '0x203d82d8': 'Expired()',
  '0xcd4e6167': 'FeeTooHigh()',
  '0x6e11e93f': 'HookNotAllowed()',
  '0xb28b479c': 'HopPoolInvalid()',
  '0xb2151907': 'InvariantBroken()',
  '0xf6cc00d0': 'LegFloor()',
  '0xaf1109da': 'NoFeeAnchor()',
  '0x1d5901ae': 'NoHops()',
  '0x9528138c': 'NoLegs()',
  '0x30cd7471': 'NotOwner()',
  '0x1853971c': 'NotPendingOwner()',
  '0xc68c7bbb': 'OrderTooLarge()',
  '0xd964f528': 'PartialFill()',
  '0xd4bd01c5': 'Paused_()',
  '0xb3e8301e': 'PoolAlreadyRegistered()',
  '0x6fa97927': 'PoolFeeTooHigh()',
  '0x71815202': 'PoolNotActive()',
  '0x739f4185': 'PoolNotRegistered()',
  '0xab143c06': 'Reentrancy()',
  '0x3ee5aeb5': 'ReentrancyGuardReentrantCall()',
  '0x7dd37f70': 'Slippage()',
  '0x8888a785': 'SumMismatch()',
  '0x7c5c7236': 'Token0Mismatch()',
  '0x0a83c852': 'TooManyHops()',
  '0x85d53c40': 'TooManyLegs()',
  '0x90b8ec18': 'TransferFailed()',
  '0x843a83c5': 'UnsupportedPath()',
  '0xd92e233d': 'ZeroAddress()',
  '0x1f2a2005': 'ZeroAmount()',
  '0x52671e5b': 'ZeroLegOutput()',
});

function findData(e: unknown): string | null {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    const d = (cur as { data?: unknown }).data;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d;
    if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') return (d as { data: string }).data;
    cur = (cur as { cause?: unknown }).cause;
  }
  const m = /custom error (0x[0-9a-fA-F]{8})/.exec(String((e as { shortMessage?: unknown })?.shortMessage ?? (e as Error)?.message ?? ''));
  return m ? m[1]! : null;
}

export function revertSummary(e: unknown): string {
  const data = findData(e);
  if (!data || data.length < 10) return 'no revert data';
  const sel = data.slice(0, 10).toLowerCase();
  if (sel === '0x08c379a0') return 'a revert reason string (not shown)';
  if (sel === '0x4e487b71') return 'a Solidity panic';
  return KNOWN[sel] ?? `custom error ${sel}`;
}
