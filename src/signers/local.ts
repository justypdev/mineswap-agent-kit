/**
 * A local private key read from a file. FOR TESTING ONLY (a fork rehearsal, a throwaway wallet):
 * the key sits unencrypted on disk and anything that can read the file can drain the wallet. The
 * config must say `"acknowledgeTestOnly": true`, and the kit prints a warning on every start.
 *
 * The RPC this signer talks to supplies the NONCE (and is the one that broadcasts). Gas and fees are
 * not the RPC's to choose: the kit estimates them, holds them to its own caps (limits.maxGasPerTx,
 * limits.maxFeePerGasWei) and passes them explicitly.
 */
import { readFileSync, statSync } from 'node:fs';
import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import type { RawSigner } from './types.js';

export const LOCAL_SIGNER_WARNING =
  '!!! MINESWAP AGENT KIT: LOCAL TEST KEY SIGNER !!!\n' +
  '!!! The private key is read from a plain file. Use it ONLY on a fork or a throwaway wallet. !!!\n' +
  '!!! For real funds use the CDP server wallet signer (signer.type = "cdp").                  !!!';

export function createLocalTestSigner(
  opts: { keyFile: string; rpcUrl: string; acknowledgeTestOnly: boolean },
  warn: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
): RawSigner {
  if (opts.acknowledgeTestOnly !== true) {
    throw new Error('the local key signer is for testing only; set signer.acknowledgeTestOnly = true to use it');
  }
  warn(LOCAL_SIGNER_WARNING);
  const st = statSync(opts.keyFile);
  if ((st.mode & 0o077) !== 0) warn(`!!! the key file is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it !!!`);
  const key = readFileSync(opts.keyFile, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('the key file must hold one 0x-prefixed 32-byte hex private key');
  const account = privateKeyToAccount(key as Hex);
  const wallet = createWalletClient({ account, chain: base, transport: http(opts.rpcUrl, { retryCount: 0 }) });
  return {
    kind: 'local-test',
    address: account.address,
    signMessage: (message) => account.signMessage({ message }),
    sendTransaction: (tx) => wallet.sendTransaction({
      to: tx.to, data: tx.data, value: tx.value, chain: base,
      gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    }),
  };
}
