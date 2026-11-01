/**
 * Startup verification: every pinned contract is re-read from the chain and compared with the
 * compiled-in code hash; the links between them and the routers' OWNER-CONTROLLED state (owner,
 * pending owner, v1's hop pool, quoter, V4 adapter, pause flag and pool registry entry by entry; v2's
 * adapters, their pay styles and the allowed hooks) are compared with pins.ts (router-state.ts, which
 * the wallet also runs before every swap and activation); the token storage slots the reference
 * simulation overrides must read back. The kit refuses to start (and so to sign anything) when one
 * check fails.
 */
import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { CHAINLINK_ABI } from '../abis.js';
import { ADDR, BASE_CHAIN_ID, CODE_HASH, ETH_USD_MAX_AGE_S, SEQUENCER_GRACE_S, type PinName } from '../pins.js';
import { verifyTokenSlots } from './reference.js';
import { readRouterState } from './router-state.js';
import { GuardRefusal } from './refusal.js';

export interface PinReport {
  readonly chainId: number;
  readonly block: bigint;
  readonly checks: ReadonlyArray<{ readonly name: string; readonly ok: boolean; readonly detail: string }>;
}

/** A key-less address the slot read-back probe uses: keccak256("mineswap-agent-kit:slot-probe")[12:]. */
export const SLOT_PROBE: Address = '0xE2687dA3D1C833990Cd4aeab9eEc39ebFD3017eA';

export async function verifyPins(client: PublicClient): Promise<PinReport> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const chainId = await client.getChainId();
  checks.push({ name: 'chainId', ok: chainId === BASE_CHAIN_ID, detail: `chain ${chainId}` });
  const block = await client.getBlockNumber();

  for (const name of Object.keys(ADDR) as PinName[]) {
    const code = (await client.getCode({ address: ADDR[name] })) ?? '0x';
    const hash = code === '0x' ? 'no code' : keccak256(code as Hex);
    checks.push({ name: `code:${name}`, ok: hash === CODE_HASH[name], detail: `${ADDR[name]} ${hash}` });
  }

  // The links between the contracts, the routers' owner-controlled state (v1 registry entry by
  // entry), and the Chainlink feeds' identities: the same reader the wallet runs before every swap.
  checks.push(...await readRouterState(client));

  checks.push(...await verifyTokenSlots(client, SLOT_PROBE));
  return { chainId, block, checks };
}

/** Throws PIN_MISMATCH naming every failed check. */
export function assertPins(report: PinReport): void {
  const failed = report.checks.filter((c) => !c.ok);
  if (failed.length) {
    throw new GuardRefusal('PIN_MISMATCH', `startup verification failed, nothing will be signed: ${failed.map((c) => `${c.name} (${c.detail})`).join('; ')}`);
  }
}

/**
 * Chainlink ETH/USD, refusing when the Base sequencer is reported down or came back less than
 * SEQUENCER_GRACE_S ago, and when the answer is older than the feed's heartbeat
 * (ETH_USD_MAX_AGE_S) or not positive.
 */
export async function readEthUsd(client: PublicClient, nowSec: number): Promise<{ answer: bigint; decimals: number }> {
  try {
    const [, status, startedAt] = await client.readContract({ address: ADDR.sequencerUptime, abi: CHAINLINK_ABI, functionName: 'latestRoundData' });
    if (status !== 0n) throw new GuardRefusal('PRICE_UNAVAILABLE', 'the Base sequencer is reported down, so the ETH/USD price is not trusted');
    if (nowSec - Number(startedAt) < SEQUENCER_GRACE_S) throw new GuardRefusal('PRICE_UNAVAILABLE', 'the Base sequencer came back up less than an hour ago; the ETH/USD price is not trusted yet');
    const [, answer, , updatedAt] = await client.readContract({ address: ADDR.chainlinkEthUsd, abi: CHAINLINK_ABI, functionName: 'latestRoundData' });
    if (answer <= 0n) throw new GuardRefusal('PRICE_UNAVAILABLE', 'the ETH/USD price is not positive');
    if (nowSec - Number(updatedAt) > ETH_USD_MAX_AGE_S) throw new GuardRefusal('PRICE_UNAVAILABLE', `the ETH/USD price is ${nowSec - Number(updatedAt)} s old, past the feed's heartbeat`);
    return { answer, decimals: 8 };
  } catch (e) {
    if (e instanceof GuardRefusal) throw e;
    throw new GuardRefusal('PRICE_UNAVAILABLE', 'the ETH/USD price could not be read, so the USD caps cannot be checked');
  }
}
