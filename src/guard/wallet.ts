/**
 * GuardedWallet — THE signing path. It is the only object that ever holds a RawSigner (a private
 * field), and every transaction it sends passes `authorizeTransaction` immediately before the
 * signer is called, including the approvals it builds itself. Messages pass `authorizeMessage`.
 * There is no method that signs typed data, and no method that sends caller-supplied calldata
 * without a decoded, checked purpose.
 *
 * A swap is two calls in a fixed order:
 *   prepareSwap(tx, want)  decode the quote's calldata, hold it to the request (tokens, recipient,
 *                          value, floor, deadline, size), price it against the REFERENCE route
 *                          (router v1's own UniV2 entry, guard/reference.ts) and check the caps.
 *   executeSwap(prepared)  approve EXACTLY the swap's input to the router it targets, simulate the
 *                          exact calldata from this wallet at the latest block, hold the floor to
 *                          that simulation AND to a fresh reference, then atomically check and
 *                          record the USD spend, send, wait, and revoke any residue.
 * The approval is revoked whenever the swap does not complete: a refusal after the approval, a
 * failed send, a revert. Gas and fees are estimated by the kit and held to its caps.
 */
import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { ERC20_ABI, GOLD_MINE_NFT_ABI, MINE_BURN_ENTRY_ABI, ROUTER_V1_ABI, ROUTER_V2_ABI } from '../abis.js';
import { ADDR, ETH_SENTINEL, MINE_BURN_AMOUNT, SELECTOR, sameAddress } from '../pins.js';
import type { RawSigner, TxFees } from '../signers/types.js';
import { decodeIntent, type Intent, type SwapIntent, type TxRequest } from './decode.js';
import { KitIncident, failureLabel } from './incident.js';
import type { SpendLedger } from './ledger.js';
import { authorizeMessage, type AuthorizedMessage } from './messages.js';
import {
  centsToUsd, checkApproval, checkCaps, checkReferenceFloor, checkSlippage, checkSwap, requestSlippageBps,
  usdcToCents, v1EntryPath, weiToCents, type Limits, type SwapExpectation,
} from './policy.js';
import { referenceOut } from './reference.js';
import { assertRouterState } from './router-state.js';
import { GuardRefusal, refuse } from './refusal.js';
import { revertSummary } from './revert.js';
import { assertPins, readEthUsd, verifyPins, type PinReport } from './verify-pins.js';

/** What a transaction is allowed to be, bound by the code path that builds it. */
export type TxBinding =
  | { readonly kind: 'approval'; readonly spender: Address; readonly amount: bigint; readonly token: Address }
  | { readonly kind: 'swap'; readonly intent: SwapIntent; readonly want: SwapExpectation }
  | { readonly kind: 'activate' };

/**
 * The final gate. Decodes `tx` and requires it to be exactly what `binding` says it is. Exported
 * so the hostile-calldata table can drive it directly; GuardedWallet calls it before every send.
 */
export function authorizeTransaction(tx: TxRequest, binding: TxBinding, ctx: { self: Address; nowSec: number; limits: Limits }): Intent {
  const intent = decodeIntent(tx);
  switch (intent.kind) {
    case 'approve': {
      if (binding.kind !== 'approval') return refuse('SELECTOR_NOT_ALLOWED', 'an approval is only signed for the swap or activation it funds');
      if (!sameAddress(intent.token, binding.token)) refuse('TOKEN_MISMATCH', `the approval is on ${intent.token}, but the call it funds spends ${binding.token}`);
      checkApproval(intent, binding);
      return intent;
    }
    case 'swap': {
      if (binding.kind !== 'swap') return refuse('SELECTOR_NOT_ALLOWED', 'a swap is only signed through prepareSwap/executeSwap');
      const p = binding.intent;
      const same = intent.router === p.router && intent.fn === p.fn && sameAddress(intent.tokenIn, p.tokenIn)
        && sameAddress(intent.tokenOut, p.tokenOut) && intent.spend === p.spend && intent.minOut === p.minOut
        && sameAddress(intent.recipient, p.recipient) && intent.deadline === p.deadline && intent.value === p.value;
      if (!same) refuse('AMOUNT_MISMATCH', 'the transaction to sign differs from the swap that was checked');
      checkSwap(intent, ctx, binding.want);
      return intent;
    }
    case 'activate': {
      if (binding.kind !== 'activate') return refuse('SELECTOR_NOT_ALLOWED', 'activate() is only signed through activateMine');
      return intent;
    }
  }
}

export interface PreparedSwap {
  readonly intent: SwapIntent;
  readonly tx: TxRequest;
  readonly want: SwapExpectation;
}

export interface SwapResult {
  readonly router: 'v1' | 'v2';
  /** The router function that was sent. */
  readonly fn: SwapIntent['fn'];
  /** True when the kit raised its own floor to the simulation (kit-built UniV2-entry swaps only). */
  readonly tightened: boolean;
  readonly routerAddress: Address;
  readonly approveHash: Hex | null;
  readonly swapHash: Hex;
  readonly revokeHash: Hex | null;
  readonly spend: bigint;
  readonly minOut: bigint;
  readonly simulatedOut: bigint;
  /** What router v1's own UniV2 entry would pay for the same input: the floor is held to it. */
  readonly referenceOut: bigint;
  /** Measured balance change of tokenOut (ERC-20 outputs only; null for native ETH out). */
  readonly receivedOut: bigint | null;
  readonly spendUsd: string;
  /** Set when the swap completed but a leftover approval could not be revoked (a fixed sentence). */
  readonly warning: string | null;
}

export interface WalletDeps {
  readonly client: PublicClient;
  readonly signer: RawSigner;
  readonly limits: Limits;
  readonly ledger: SpendLedger;
  readonly now?: () => number;
  readonly receiptTimeoutMs?: number;
}

/**
 * Construction token. Module-private: it is not reachable from the class (no static member, no
 * symbol-keyed property), so `new GuardedWallet(...)` from outside this module always throws.
 */
const CONSTRUCT = Symbol('GuardedWallet.construct');

export class GuardedWallet {
  readonly #signer: RawSigner;
  readonly #client: PublicClient;
  readonly #limits: Limits;
  readonly #ledger: SpendLedger;
  readonly #now: () => number;
  readonly #receiptTimeoutMs: number;
  readonly #prepared = new WeakSet<PreparedSwap>();
  /** Swaps whose calldata the KIT built (prepareV1EntrySwap): their floor may be raised to the simulation. */
  readonly #kitBuilt = new WeakSet<PreparedSwap>();
  #queue: Promise<unknown> = Promise.resolve();
  readonly address: Address;
  readonly signerKind: RawSigner['kind'];
  readonly pinReport: PinReport;

  constructor(token: symbol, deps: WalletDeps, report: PinReport) {
    if (token !== CONSTRUCT) throw new Error('use GuardedWallet.create(), which verifies the pinned contracts first');
    this.#signer = deps.signer;
    this.#client = deps.client;
    this.#limits = deps.limits;
    this.#ledger = deps.ledger;
    this.#now = deps.now ?? Date.now;
    this.#receiptTimeoutMs = deps.receiptTimeoutMs ?? 180_000;
    this.address = getAddress(deps.signer.address);
    this.signerKind = deps.signer.kind;
    this.pinReport = report;
  }

  /** Verifies every pin on chain first; throws PIN_MISMATCH (and signs nothing) when one fails. */
  static async create(deps: WalletDeps): Promise<GuardedWallet> {
    const report = await verifyPins(deps.client);
    assertPins(report);
    return new GuardedWallet(CONSTRUCT, deps, report);
  }

  get limits(): Limits { return this.#limits; }

  #ctx() {
    return { self: this.address, nowSec: Math.floor(this.#now() / 1000), limits: this.#limits };
  }

  /** One signing operation at a time within this process (the ledger lock covers other processes). */
  #serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(f, f);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Gas and fee terms, estimated by the kit and held to its caps. */
  async #fees(tx: TxRequest): Promise<TxFees> {
    let estimate: bigint;
    try {
      estimate = await this.#client.estimateGas({ account: this.address, to: tx.to, data: tx.data, value: tx.value });
    } catch (e) {
      return refuse('SIMULATION_FAILED', `the transaction cannot be estimated (${revertSummary(e)})`);
    }
    const gas = (estimate * 125n) / 100n;
    if (gas > this.#limits.maxGasPerTx) refuse('GAS_CAP_EXCEEDED', `the transaction needs about ${gas} gas, above the cap of ${this.#limits.maxGasPerTx}`);
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.#client.estimateFeesPerGas();
    if (maxFeePerGas > this.#limits.maxFeePerGasWei) {
      refuse('FEE_CAP_EXCEEDED', `the network asks ${maxFeePerGas} wei per gas, above the cap of ${this.#limits.maxFeePerGasWei}`);
    }
    return { gas, maxFeePerGas, maxPriorityFeePerGas: maxPriorityFeePerGas > maxFeePerGas ? maxFeePerGas : maxPriorityFeePerGas };
  }

  async #send(tx: TxRequest, binding: TxBinding): Promise<Hex> {
    authorizeTransaction(tx, binding, this.#ctx());
    const fees = await this.#fees(tx);
    const step = binding.kind === 'approval' ? (binding.amount === 0n ? 'revoke' : 'approval') : binding.kind;
    let hash: Hex;
    try {
      hash = await this.#signer.sendTransaction({ to: getAddress(tx.to), data: tx.data, value: tx.value, ...fees });
    } catch (e) {
      // e.g. a CDP policy rejection (APIError errorType "policy_violation"); only a stable label is kept.
      const t = (e as { errorType?: unknown; name?: unknown });
      throw new KitIncident('SEND_FAILED', { step, kind: typeof t.errorType === 'string' ? t.errorType : typeof t.name === 'string' ? t.name : 'Error' });
    }
    let status: string;
    try {
      ({ status } = await this.#client.waitForTransactionReceipt({ hash, timeout: this.#receiptTimeoutMs }));
    } catch {
      throw new KitIncident('RECEIPT_UNKNOWN', { step, hash });
    }
    if (status !== 'success') throw new KitIncident('TX_REVERTED', { step, hash });
    return hash;
  }

  async #balance(token: Address): Promise<bigint> {
    if (sameAddress(token, ETH_SENTINEL)) return this.#client.getBalance({ address: this.address });
    return this.#client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [this.address] });
  }

  async #allowance(token: Address, spender: Address): Promise<bigint> {
    return this.#client.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [this.address, spender] });
  }

  async #setAllowance(token: Address, spender: Address, amount: bigint): Promise<Hex> {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] });
    return this.#send({ to: token, data, value: 0n }, { kind: 'approval', token, spender, amount });
  }

  /** Revoke any allowance left on `spender`; a failure to revoke is reported, never swallowed. */
  async #revokeIfAny(token: Address, spender: Address): Promise<Hex | null> {
    if ((await this.#allowance(token, spender)) === 0n) return null;
    return this.#setAllowance(token, spender, 0n);
  }

  async #reference(intent: SwapIntent): Promise<bigint> {
    return referenceOut(this.#client, this.address, intent.tokenIn, intent.tokenOut, intent.spend, BigInt(this.#ctx().nowSec + 600));
  }

  /**
   * USD value of a swap's input, in cents. USDC exactly; ETH/WETH at Chainlink; BG at the
   * REFERENCE route's output (USDC, or WETH at Chainlink), never at the route's own output.
   */
  async #spendCents(intent: SwapIntent, reference: bigint): Promise<bigint> {
    const nowSec = this.#ctx().nowSec;
    const valueOf = async (token: Address, amount: bigint): Promise<bigint> => {
      if (sameAddress(token, ADDR.usdc)) return usdcToCents(amount);
      const { answer, decimals } = await readEthUsd(this.#client, nowSec);
      return weiToCents(amount, answer, decimals);
    };
    return sameAddress(intent.tokenIn, ADDR.bg) ? valueOf(intent.tokenOut, reference) : valueOf(intent.tokenIn, intent.spend);
  }

  /** The static swap checks on a decoded intent, at this wallet's clock and limits. Signs nothing. */
  checkSwapStatic(intent: SwapIntent, want: SwapExpectation): void {
    checkSwap(intent, this.#ctx(), want);
  }

  async prepareSwap(tx: TxRequest, want: SwapExpectation): Promise<PreparedSwap> {
    const intent = decodeIntent(tx);
    if (intent.kind !== 'swap') refuse('SELECTOR_NOT_ALLOWED', `the quote's calldata is ${intent.kind}, not a swap`);
    const swap = intent as SwapIntent;
    checkSwap(swap, this.#ctx(), want);
    // The routers' owner-controlled state, re-read now (the reference is router v1's own route).
    await assertRouterState(this.#client);
    const balance = await this.#balance(swap.tokenIn);
    if (balance < swap.spend) refuse('INSUFFICIENT_BALANCE', `the wallet holds ${balance} of ${swap.tokenIn} but the swap spends ${swap.spend}`);
    // Before anything is approved: the floor against the reference, and a first (advisory) cap check.
    // executeSwap repeats both against fresh reads and records the spend atomically.
    const reference = await this.#reference(swap);
    checkReferenceFloor(swap.minOut, reference, this.#limits.maxSlippageBps);
    checkCaps(await this.#spendCents(swap, reference), this.#ledger.spentInWindow(this.address, this.#now()), this.#limits);
    const prepared: PreparedSwap = Object.freeze({ intent: swap, tx: Object.freeze({ ...tx }), want: Object.freeze({ ...want }) });
    this.#prepared.add(prepared);
    return prepared;
  }

  /**
   * A v1 UniV2-entry swap (swapExactTokensForTokens) the KIT builds, for a pair whose quote came
   * back as a stale-prone entry-hop swapExactInPath: the router derives the legs on chain, so a moved
   * hop pool cannot make it revert. `amountIn` is sized from the quote; `floor` is the least output
   * the caller accepts. executeSwap raises the floor toward its own simulation (requestSlippageBps
   * under it), never lowers it, and every check of prepareSwap applies.
   */
  async prepareV1EntrySwap(p: { tokenIn: Address; tokenOut: Address; amountIn: bigint; floor: bigint; want: SwapExpectation }): Promise<PreparedSwap> {
    const path = v1EntryPath(p.tokenIn, p.tokenOut);
    if (!path) return refuse('PATH_NOT_ALLOWED', `v1's UniV2 entry has no path the kit sends for ${p.tokenIn} → ${p.tokenOut}`);
    const deadline = BigInt(this.#ctx().nowSec + Math.min(1200, this.#limits.maxDeadlineSeconds));
    const data = encodeFunctionData({ abi: ROUTER_V1_ABI, functionName: 'swapExactTokensForTokens', args: [p.amountIn, p.floor, [...path], this.address, deadline] });
    const prepared = await this.prepareSwap({ to: ADDR.routerV1, data, value: 0n }, p.want);
    this.#kitBuilt.add(prepared);
    return prepared;
  }

  async #simulateSwap(intent: SwapIntent, tx: TxRequest): Promise<bigint> {
    let ret: Hex | undefined;
    try {
      ({ data: ret } = await this.#client.call({ account: this.address, to: tx.to, data: tx.data, value: tx.value }));
    } catch (e) {
      return refuse('SIMULATION_FAILED', `the swap reverts when simulated from this wallet (${revertSummary(e)})`);
    }
    if (!ret || ret === '0x') refuse('SIMULATION_FAILED', 'the router returned nothing when simulated');
    if (intent.fn === 'swapExactTokensForTokens') {
      const amounts = decodeFunctionResult({ abi: ROUTER_V1_ABI, functionName: 'swapExactTokensForTokens', data: ret! }) as readonly bigint[];
      if (amounts.length < 2) refuse('SIMULATION_FAILED', 'the UniV2 entry returned no output amount');
      return amounts[amounts.length - 1]!;
    }
    if (intent.router === 'v1') {
      return decodeFunctionResult({ abi: ROUTER_V1_ABI, functionName: 'swapExactInPath', data: ret! }) as bigint;
    }
    if (intent.fn === 'swapExactIn') {
      return decodeFunctionResult({ abi: ROUTER_V2_ABI, functionName: 'swapExactIn', data: ret! }) as bigint;
    }
    const [amountIn, amountOut] = decodeFunctionResult({ abi: ROUTER_V2_ABI, functionName: 'swapExactOut', data: ret! }) as readonly [bigint, bigint];
    if (amountIn > intent.spend) refuse('SIMULATION_FAILED', `the exact-out swap would pull ${amountIn}, above its own ceiling ${intent.spend}`);
    return amountOut;
  }

  async executeSwap(prepared: PreparedSwap): Promise<SwapResult> {
    if (!this.#prepared.has(prepared)) refuse('INVALID_ARGUMENT', 'executeSwap only takes a swap returned by prepareSwap on this wallet');
    this.#prepared.delete(prepared);
    const kitBuilt = this.#kitBuilt.has(prepared);
    return this.#serial(async () => {
      let { intent, tx } = prepared;
      const { want } = prepared;
      let tightened = false;
      checkSwap(intent, this.#ctx(), want);
      // Before anything is approved: the routers' owner-controlled state, re-read.
      await assertRouterState(this.#client);
      const erc20In = !sameAddress(intent.tokenIn, ETH_SENTINEL);
      let approveHash: Hex | null = null;
      let revokeHash: Hex | null = null;
      if (erc20In && (await this.#allowance(intent.tokenIn, intent.routerAddress)) !== intent.spend) {
        approveHash = await this.#setAllowance(intent.tokenIn, intent.routerAddress, intent.spend);
      }
      let simulatedOut: bigint;
      let reference: bigint;
      let cents: bigint;
      let swapHash: Hex;
      try {
        simulatedOut = await this.#simulateSwap(intent, tx);
        if (kitBuilt && simulatedOut >= intent.minOut) {
          // Raise the kit's own floor to requestSlippageBps under what the router pays right now.
          const fromSim = (simulatedOut * BigInt(10_000 - requestSlippageBps(this.#limits.maxSlippageBps))) / 10_000n;
          if (fromSim > intent.minOut) {
            const path = intent.path ?? [];
            const data = encodeFunctionData({ abi: ROUTER_V1_ABI, functionName: 'swapExactTokensForTokens', args: [intent.spend, fromSim, [...path], this.address, intent.deadline] });
            const next = decodeIntent({ to: ADDR.routerV1, data, value: 0n }) as SwapIntent;
            checkSwap(next, this.#ctx(), want);
            tx = Object.freeze({ to: ADDR.routerV1, data, value: 0n });
            intent = next;
            tightened = true;
            simulatedOut = await this.#simulateSwap(intent, tx);
          }
        }
        checkSlippage(intent.minOut, simulatedOut, this.#limits.maxSlippageBps);
        // Once more, immediately before the reference this swap is held to and the send.
        await assertRouterState(this.#client);
        reference = await this.#reference(intent);
        checkReferenceFloor(intent.minOut, reference, this.#limits.maxSlippageBps);
        cents = await this.#spendCents(intent, reference);
        // Atomic across processes: re-checks both caps on the ledger and records the spend.
        this.#ledger.reserveWithin(this.address, cents, this.#limits, this.#now());
        const outBefore = sameAddress(intent.tokenOut, ETH_SENTINEL) ? null : await this.#balance(intent.tokenOut);
        swapHash = await this.#send(tx, { kind: 'swap', intent, want });
        const receivedOut = outBefore === null ? null : (await this.#balance(intent.tokenOut)) - outBefore;
        if (receivedOut !== null && receivedOut < intent.minOut) {
          throw new KitIncident('RECEIVED_BELOW_FLOOR', { hash: swapHash, received: receivedOut < 0n ? '0' : receivedOut, token: intent.tokenOut, floor: intent.minOut });
        }
        // The swap completed. A residue the router did not pull (exact-out) is revoked; if that fails,
        // the swap still stands and the result carries the warning instead of an error.
        let warning: string | null = null;
        if (erc20In) {
          try {
            revokeHash = await this.#revokeIfAny(intent.tokenIn, intent.routerAddress);
          } catch (revokeErr) {
            warning = `WARNING (APPROVAL_NOT_REVOKED): ${new KitIncident('APPROVAL_NOT_REVOKED', { token: intent.tokenIn, spender: intent.routerAddress, after: failureLabel(revokeErr) }).message}`;
          }
        }
        return {
          router: intent.router, fn: intent.fn, tightened, routerAddress: intent.routerAddress, approveHash, swapHash, revokeHash,
          spend: intent.spend, minOut: intent.minOut, simulatedOut, referenceOut: reference, receivedOut, spendUsd: centsToUsd(cents), warning,
        };
      } catch (e) {
        // The swap did not complete (a refusal, a failed or reverted send): never leave the approval.
        if (erc20In) {
          try {
            await this.#revokeIfAny(intent.tokenIn, intent.routerAddress);
          } catch {
            // The original failure is named by its stable code; the user must revoke by hand.
            throw new KitIncident('APPROVAL_NOT_REVOKED', { token: intent.tokenIn, spender: intent.routerAddress, after: failureLabel(e) });
          }
        }
        throw e;
      }
    });
  }

  async hasMine(): Promise<boolean> {
    return this.#client.readContract({ address: ADDR.goldMineNft, abi: GOLD_MINE_NFT_ABI, functionName: 'hasMine', args: [this.address] });
  }

  /** The wallet's Gold Mine id, read on chain; null when it has none. */
  async mineId(): Promise<number | null> {
    if (!(await this.hasMine())) return null;
    const id = await this.#client.readContract({ address: ADDR.goldMineNft, abi: GOLD_MINE_NFT_ABI, functionName: 'getMineIdByAddress', args: [this.address] });
    return id > 0n && id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : null;
  }

  /** Burn exactly 0.1 BG through MineBurnEntry and mint this wallet's Gold Mine. */
  async activateMine(): Promise<{ mineId: number; approveHash: Hex | null; activateHash: Hex }> {
    return this.#serial(async () => {
      await assertRouterState(this.#client);
      const existing = await this.mineId();
      if (existing !== null) refuse('ALREADY_HAS_MINE', `this wallet already has Gold Mine #${existing} (one mine per address)`);
      const bg = await this.#balance(ADDR.bg);
      if (bg < MINE_BURN_AMOUNT) refuse('INSUFFICIENT_BALANCE', `activation burns 0.1 BG and the wallet holds ${bg} wei of BG; call buy_bg first`);
      let approveHash: Hex | null = null;
      if ((await this.#allowance(ADDR.bg, ADDR.mineBurnEntry)) !== MINE_BURN_AMOUNT) {
        approveHash = await this.#setAllowance(ADDR.bg, ADDR.mineBurnEntry, MINE_BURN_AMOUNT);
      }
      const data = encodeFunctionData({ abi: MINE_BURN_ENTRY_ABI, functionName: 'activate' });
      if (data !== SELECTOR.activate) refuse('MALFORMED_CALLDATA', 'activate() encodes unexpectedly');
      let activateHash: Hex;
      try {
        try {
          await this.#client.call({ account: this.address, to: ADDR.mineBurnEntry, data });
        } catch (e) {
          refuse('SIMULATION_FAILED', `activate() reverts when simulated (${revertSummary(e)})`);
        }
        activateHash = await this.#send({ to: ADDR.mineBurnEntry, data, value: 0n }, { kind: 'activate' });
      } catch (e) {
        try {
          await this.#revokeIfAny(ADDR.bg, ADDR.mineBurnEntry);
        } catch {
          throw new KitIncident('APPROVAL_NOT_REVOKED', { token: ADDR.bg, spender: ADDR.mineBurnEntry, after: failureLabel(e) });
        }
        throw e;
      }
      const mineId = await this.mineId();
      if (mineId === null) throw new KitIncident('MINE_NOT_VISIBLE', { hash: activateHash });
      return { mineId, approveHash, activateHash };
    });
  }

  /** Signs `message` only if it is exactly one of the two game-login messages for this wallet. */
  async signLoginMessage(message: string): Promise<{ signature: Hex; authorized: AuthorizedMessage }> {
    const mineId = await this.mineId();
    const authorized = authorizeMessage(message, { self: this.address, mineId, nowMs: this.#now() });
    return { signature: await this.#signer.signMessage(message), authorized };
  }

  /** Typed data (EIP-712: permits, Permit2, orders) is never signed. */
  async signTypedData(_typedData: unknown): Promise<never> {
    throw new GuardRefusal('TYPED_DATA_REFUSED', 'typed-data signatures (permits, Permit2, off-chain orders) are never signed by the kit');
  }

  async balances(): Promise<{ eth: bigint; usdc: bigint; bg: bigint; weth: bigint }> {
    const [eth, usdc, bg, weth] = await Promise.all([this.#balance(ETH_SENTINEL), this.#balance(ADDR.usdc), this.#balance(ADDR.bg), this.#balance(ADDR.weth)]);
    return { eth, usdc, bg, weth };
  }

  /** Cents spent in the last 24 hours (rolling). */
  spentLast24hCents(): bigint {
    return this.#ledger.spentInWindow(this.address, this.#now());
  }
}

/**
 * @internal A wallet over a mocked chain, skipping the on-chain pin check, for the kit's own unit
 * tests ONLY: it throws unless it runs under vitest (VITEST=true). It is not re-exported from the
 * package index, and package.json `exports` blocks deep imports for package consumers; code inside
 * this repository (or a modified install) can still reach it, which is why it is also env-gated.
 */
export function __createWalletForTests(deps: WalletDeps, report: PinReport): GuardedWallet {
  if (process.env.VITEST !== 'true') throw new Error('__createWalletForTests is for the kit\'s unit tests only');
  return new GuardedWallet(CONSTRUCT, deps, report);
}
