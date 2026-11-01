import type { Address, Hex } from 'viem';

/** The fee terms the kit decided (and capped) itself; a signer must send exactly these. */
export interface TxFees {
  readonly gas: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

/**
 * A raw signer: it signs whatever it is handed. It is NEVER exported from the package index and
 * never handed to a tool. The only object that holds one is `GuardedWallet` (src/guard/wallet.ts),
 * which runs every transaction and message through the guard first.
 */
export interface RawSigner {
  readonly kind: 'cdp' | 'local-test';
  readonly address: Address;
  signMessage(message: string): Promise<Hex>;
  sendTransaction(tx: { to: Address; data: Hex; value: bigint } & TxFees): Promise<Hex>;
}
