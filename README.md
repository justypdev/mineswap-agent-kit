# MineSwap agent kit

Give an AI agent a Base wallet with a few USDC, and it can buy BG, activate a Gold Mine and mine gold
for you. The kit is an MCP server (stdio) over a small TypeScript library. Every signature it makes
passes a local guard first, so a tricked agent, or a hostile quote server, cannot move your funds
anywhere unexpected. The section [What protects what](#what-protects-what) says exactly how far that
goes.

```
USDC in the agent wallet ──buy_bg──▶ 0.1 BG ──activate_mine──▶ Gold Mine NFT ──login──▶ mine / upgrade / expedition / claim
```

> Status: not published yet. Install it from this repository (below). To report a vulnerability,
> use GitHub's [private vulnerability reporting](https://github.com/justypdev/mineswap-agent-kit/security/advisories/new)
> (see [SECURITY.md](SECURITY.md)), not a public issue.

## Quick start

1. **Run it as its own OS user (or in its own container).** The kit's CDP credentials, its RPC URL
   and its spend ledger should be readable by that user only. Do not run it as the user whose
   desktop, browser or other agents can read those files.

   ```bash
   sudo useradd --create-home --shell /usr/sbin/nologin mineswap-agent
   ```

2. **Build it** (as that user).

   ```bash
   cd agent-kit
   npm ci
   npm run build
   ```

3. **Create TWO Coinbase CDP API keys** at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com):
   - **the kit's key**, with the API restriction **"Non-custodial > Manage (modify policies)" OFF**,
     plus the project's wallet secret. This is the only key that goes on the kit's machine.
   - **an admin key**, with policy management ON. It never goes on the kit's machine. You use it only
     to create, check and change the wallet policy (step 7).

   Write the kit's key into a file only the kit's user can read:

   ```bash
   install -m 600 /dev/null ~/.mineswap-agent-kit/cdp-credentials.json
   # {"apiKeyId": "…", "apiKeySecret": "…", "walletSecret": "…"}
   ```

   The kit refuses a credentials file that other users can read, or that another user owns.

4. **Write a config file**, for example `~/.mineswap-agent-kit/config.json`:

   ```json
   {
     "signer": { "type": "cdp", "accountName": "mineswap-agent", "credentialsFile": "~/.mineswap-agent-kit/cdp-credentials.json" },
     "rpcUrl": "https://mainnet.base.org",
     "limits": { "maxSlippageBps": 100, "maxTxUsd": 5, "maxDailyUsd": 20 }
   }
   ```

5. **Add it to your MCP client.** Put no secrets in the client's config. The kit reads them from the
   credentials file.

   ```json
   {
     "mcpServers": {
       "mineswap": {
         "command": "sudo",
         "args": ["-u", "mineswap-agent", "node", "/opt/mineswap-agent-kit/dist/bin.js", "--config", "/home/mineswap-agent/.mineswap-agent-kit/config.json"]
       }
     }
   }
   ```

   If the client runs as the same user as the kit, use `node /path/to/dist/bin.js --config …`
   instead. Never put `CDP_API_KEY_SECRET` or `CDP_WALLET_SECRET` in that JSON: MCP client configs are
   commonly synced, shared and readable by other tools.

6. **Fund the wallet.** Ask the agent for `wallet_status`. On first start the kit creates (or
   finds) the CDP account named in the config and prints its address. Send it:
   - about **2 USDC** (one mine costs 0.1 BG, which was about 1.06 USDC on 2026-10-31);
   - about **0.0005 ETH** for gas. A CDP server account is a normal account and pays its own gas; the
     whole flow is five transactions and costs a few cents on Base.

7. **Apply the CDP wallet policy** with the ADMIN key. See [below](#the-cdp-wallet-policy-owner-step).

8. **Tell the agent what you want.** For example: *"Buy 0.1 BG, activate my Gold Mine, log in and
   mine."* It will call:

   | Step | Tool | What happens on chain or on mineswap.app |
   |---|---|---|
   | 1 | `buy_bg { bgAmount: "0.1" }` | exact USDC approval to the router, then the swap; at least 0.1 BG arrives |
   | 2 | `activate_mine` | exact 0.1 BG approval to MineBurnEntry, then `activate()`; 0.1 BG is burned and the mine is minted to the wallet |
   | 3 | `login` | signs the war-auth sign-in challenge for www.mineswap.app; the session token stays in memory |
   | 4 | `state`, `mine`, `upgrade`, `expedition`, `claim` | plays the mine through the game's agent API |

## Tools

| Tool | Kind | Inputs | Notes |
|---|---|---|---|
| `wallet_status` | read | none | address, ETH/USDC/BG balances, mine id, caps, spent in the last 24 hours, pin check |
| `quote` | read | `tokenIn`, `tokenOut`, `amountIn` or `amountOut` | asks mineswap.org, decodes the router call and runs the static guard checks; signs nothing |
| `buy_bg` | signs | `bgAmount` (default `"0.1"`), optional `maxUsdc` | USDC→BG, exact output |
| `swap` | signs | `tokenIn`, `tokenOut` (USDC, BG, WETH, ETH; BG on exactly one side), `amountIn`, optional `minAmountOut` | exact input |
| `activate_mine` | signs | none | burns exactly 0.1 BG; one Gold Mine per wallet (a wallet that has one is refused with `ALREADY_HAS_MINE`) |
| `login` | signs a message | none | war-auth for the wallet's OWN mine (its id is read on chain) |
| `state` | game | `includeSmelter?` | |
| `mine` | game | `clicks` (1–10000) | the server allows 12 calls a minute, at least 5 s apart; the kit waits |
| `upgrade` | game | `upgradeId`, `count` (1–10) | spends in-game gold |
| `expedition` | game | `action` (`start`, `claim`, `status`), `type` (`shallow`, `deep`, `legendary`) | under the new expedition rules a start takes 10 / 20 / 30 scouts (refused with `SCOUTS` when fewer are at home); the claim can fail: half the gold and half the scouts. Trips already underway when the rules switched on finish under the old rules |
| `claim` | game | `action` (`status`, `claim`, `history`), optional `batchId` | queues smelted BG for payout to the mine owner's wallet |

No tool takes an address, a recipient, a spender, calldata or a message to sign. Those always come
from the kit's own pins and the wallet itself. Results are typed fields the kit picks out. Server
text (an error sentence, a message) is never passed to the agent, and nor is a revert string.

## The safety model

The kit trusts nothing it is given at runtime. That covers the quote server's response, tool
arguments, the prompt and server text. Only `src/guard/wallet.ts` (`GuardedWallet`) ever holds the
signer, and every transaction it sends passes `authorizeTransaction` immediately before signing.
That includes the approvals the kit builds itself.

**Pinned contracts, verified at startup.** The kit refuses to start, and so signs nothing, when any
of these checks fails:

- each contract's runtime code hash;
- the token storage slots the reference simulation uses (below);
- everything in the next paragraph.

**Owner-controlled state, re-read before EVERY swap and activation.** Both routers are owned by one
key, which can change them during a long session. So at startup, and again before every swap (when
it is prepared, before its approval, and immediately before its reference price and send) and before
every activation, the kit re-reads all of the following in one Multicall3 call and refuses on any
difference (`ROUTER_STATE_CHANGED`):

- for both routers: the owner, and that no ownership transfer is pending;
- v1: the hop pool, the on-chain quoter, the V4 adapter, the fee collector and fee, the pause flag,
  and its 29-pool registry entry by entry (order, tokens, kind, fee, active flag, Aerodrome factory),
  so an added, removed, deactivated or re-registered pool stops the kit;
- v2: its three adapters and their pay styles, and the two allowed V4 hooks;
- the links between MineBurnEntry, the Mine NFT and BG, and the Chainlink feeds' identities.

When the owner changes any of these, the kit signs nothing until a release pins the new values.
Two limits:
- v2's `hookAllowed` is a mapping, so a hook allowed after this release cannot be seen. That is one
  reason BG is never sold through v2.
- A change that lands in the seconds between the last read and the swap's inclusion is not caught.
  The swap's floor, held to the reference read just before it, still bounds the result.

| Contract | Address | Why |
|---|---|---|
| MineSwap split router (v1) | `0x7f0f058c731b479A214dA459a1AC4CF98d568Bf0` | serves every pair in its registry, USDC→BG included; also the REFERENCE route |
| MineSwap Router v2 | `0xE4cB28BcBA75899764cd8B5c52a51f20B29afEE9` | serves pairs outside the v1 registry when its flag allows; buys only |
| BG | `0x36b712A629095234F2196BbB000D1b96C12Ce78e` | |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | the proxy is pinned, not its (upgradeable) implementation |
| WETH | `0x4200000000000000000000000000000000000006` | |
| MineBurnEntry | `0xF121e113330A2ede61c81B8887b7092F03566037` | `bg()`, `nft()` and `BURN_AMOUNT() = 0.1 BG` are checked |
| Gold Mine NFT | `0x4F8f97e10E2D89Bc118d6fdfe74d1C96A821E4e3` | `goldVein()` must equal MineBurnEntry |
| Chainlink ETH/USD | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | read-only; values ETH/WETH spend for the USD caps |
| Chainlink L2 sequencer uptime | `0xBCF85224fc0756B9Fa45aA7892530B47e10b6433` | read-only; no ETH price is trusted while Base is down, or for an hour after |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | read-only; batches the owner-state re-read into one call |

**Every calldata is decoded before signing.** The kit signs exactly six (target, function) pairs:

- `approve` on USDC, BG or WETH;
- `swapExactInPath` (`0xa80b96c9`) and `swapExactTokensForTokens` (`0x38ed1739`) on router v1;
- `swapExactIn` (`0xfbd703f9`) and `swapExactOut` (`0x9bfb1e49`) on router v2;
- `activate()` (`0x0f15f4c0`) on MineBurnEntry.

Router calldata is decoded with that router's own ABI and must re-encode to identical bytes. The same
checks then apply to every swap:

- tokens are on the allowlist (USDC, BG, WETH, ETH), with BG on exactly one side;
- the tokens are the ones the tool call asked for;
- the recipient is the agent's own wallet;
- the value is 0, or exactly the input for an ETH swap;
- a minimum output is present, and at least what was asked for;
- the deadline is within 30 minutes;
- a v1 `swapExactTokensForTokens` path is one of `[WETH, BG]`, `[USDC, WETH, BG]`, `[BG, WETH]` or
  `[BG, WETH, USDC]`;
- **BG is never sold through router v2.** A v2 plan names its own pools, so a hostile quote can route
  through a "pool" that pays nothing, and the kit cannot check v2's pools against a registry.

**Every swap is held to a REFERENCE price that does not come from the route.**
- **The reference** is what router v1's own UniV2-compatible entry would pay for the same input
  right now: `swapExactTokensForTokens` over v1's owner-registered pools, with legs derived on chain.
  The kit simulates it from this wallet with an `eth_call` state override, which needs no approval
  and no funds.
- **The floor rule:** the swap's guaranteed output must be at least the reference minus
  `maxSlippageBps`, on buys and sells alike.
- **Why:** this is what stops a hostile route. Such a route "simulates fine" against its own floor
  of 1 wei, but it cannot meet a floor taken from somewhere else.
- **When there is no reference** (v1 paused, an order over v1's per-order cap, or an RPC without
  state-override support), the swap is refused.
- **The RPC** must support `eth_call` state overrides (`mainnet.base.org` and the major providers
  do).

**Slippage is also measured against the kit's own simulation of the exact calldata.** The router's
floor may sit at most `maxSlippageBps` (default 100 = 1%; hard ceiling 500) below what the router says
it would deliver. The kit asks the quote server for three quarters of that cap, so a small
difference between the off-chain quoter and the chain does not refuse an honest quote.

**Stale-prone routes are not signed.** A v1 `swapExactInPath` through an entry hop (USDC → the
USDC/WETH pool → BG legs) predicts its legs from the hop's output to the wei. It reverts whenever
that pool moves before the transaction lands, which happens in about 17% of Base blocks. So:
- `buy_bg` sizes its input from such a quote, then sends v1's UniV2 entry
  (`swapExactTokensForTokens [USDC, WETH, BG]`) that it builds itself. That entry derives its legs on
  chain. Its floor is the BG asked for, raised (never lowered) to three quarters of the slippage cap
  under the simulation.
- Any other entry-hop `swapExactInPath` is refused with `STALE_PRONE_ROUTE`: re-quote.

**USD caps** come from config:
- `maxTxUsd` applies to each swap, and `maxDailyUsd` to any rolling 24 hours.
- **Valuation:**
  - USDC is valued exactly;
  - ETH and WETH at Chainlink, refusing a price past the feed's 1200 s heartbeat (the bound is
    1500 s) and any price while the sequencer is down or less than an hour back up;
  - **a BG sell is valued at the reference route's output, never at the route's own output.**
- **The ledger:**
  - Spend is checked and recorded in one atomic step under a lock file, so two kit processes on one
    ledger cannot both pass the same check.
  - Each spend is recorded before its transaction is sent. A failed send still counts.
  - A corrupt or unreadable ledger refuses every swap.
  - A high-water sentinel in another directory makes a deleted or rolled-back ledger refuse every
    swap too (see [Resetting the spend ledger](#resetting-the-spend-ledger)).

**Gas and fees are the kit's.**
- It estimates both and refuses a transaction over `limits.maxGasPerTx` (default 2,500,000) or over
  `limits.maxFeePerGasGwei` (default 0.5 gwei; Base usually runs at 0.005–0.05).
- It passes them to the signer explicitly. With the local test signer, the RPC still supplies the
  nonce and broadcasts the transaction.

**Approvals are exact, and only to pinned spenders.**
- The spender must be the router that the swap being funded targets. The amount is exactly what that
  swap pulls. Unlimited approvals are refused.
- MineBurnEntry is approved for exactly 0.1 BG.
- Whenever a swap or activation does not complete, any allowance left on the spender is revoked.
  That covers a refusal after the approval, a failed or policy-rejected send, a revert, and the
  residue of an exact-out swap. If the revoke itself fails, the error says so, so you can revoke by
  hand.

**Refused outright:**
- any `transfer`, `transferFrom`, `safeTransferFrom`, `increaseAllowance` or WETH `withdraw`;
- a plain ETH send;
- `setApprovalForAll`, and ERC-721 `approve` on the Mine NFT;
- `permit` calls, and every typed-data signature (permits, Permit2, orders);
- any message other than the two game-login formats. The kit signs only text it rebuilds from its
  own pins:
  - the war-auth SIWE challenge for `www.mineswap.app`, this wallet and its own mine;
  - the play-session SIWE message for `www.mineswap.app` and this wallet.

**Every refusal says why**, as a stable code with a sentence, for example
`REFUSED by the agent-kit guard (MIN_OUT_BELOW_REFERENCE): the swap guarantees 1, 9999 bps under the reference price …`.

**One Gold Mine per wallet.** MineBurnEntry lets each wallet open one Gold Mine. When the wallet
already has its mine, `activate_mine` signs nothing and answers with this fixed sentence:

`REFUSED by the agent-kit guard (ALREADY_HAS_MINE): This wallet already has its one Gold Mine (one per wallet). To add another mine, buy a Clanker Mine on mineswap.app; this kit does not buy Clanker Mines. Nothing was signed for this step.`

**Anything that happens after signing is reported as a WARNING**, never as an unexplained error.
Each has a stable code and a sentence the kit writes itself:

| Code | Meaning |
|---|---|
| `SEND_FAILED` | the signer did not send (for example, the CDP policy rejected it) |
| `TX_REVERTED` | sent, and reverted on chain: gas spent, no tokens moved |
| `RECEIPT_UNKNOWN` | sent, but no receipt in time: it may still land, so check before retrying |
| `RECEIVED_BELOW_FLOOR` | the swap landed, but the wallet received less than its floor: stop and check |
| `APPROVAL_NOT_REVOKED` | an approval is still in place and could not be revoked: revoke it by hand |
| `MINE_NOT_VISIBLE` | activate landed, but the NFT shows no mine yet: check before activating again |

When a swap completes but a leftover exact-out approval cannot be revoked, the swap's result carries
the `APPROVAL_NOT_REVOKED` warning in its `warning` field.

**The network.**
- **Your RPC provider is trusted.** The kit's reference price, every simulation, the owner-state
  check, the ETH/USD price and every balance come from it. A dishonest or compromised RPC can make a
  bad swap look acceptable. Use a reputable provider, or your own Base node.
- mineswap.org rate-limits `/api/quote` to **30 requests per minute per IP**. The kit spends at most
  20 per minute, honours `Retry-After` on a 429 (the server says 60 s), and backs off exponentially
  otherwise.
- Responses are capped in size and time while they stream.
- The kit never follows a redirect.
- It talks only to `https://mineswap.org` and `https://www.mineswap.app`. Both are compiled in, so a
  config file cannot point a login at another host.

## What protects what

| Threat | What stops it |
|---|---|
| A tricked agent, prompt injection | The guard. No tool can name a destination, and only the allowlisted calls and messages are signed. |
| A hostile or broken quote server | The guard decodes and checks everything. Every floor is held to the reference route, BG sells never go through v2, and only typed numbers reach the agent. |
| A hostile route through a pool that pays nothing | The reference floor. |
| The routers' owner key changing a router mid-session | The owner-state re-read before every swap and activation (`ROUTER_STATE_CHANGED`). |
| A dishonest RPC provider | Nothing in the kit: it is trusted for prices, simulations and state. Choose it carefully. |
| A buggy kit | The guard, and, if you applied it, the CDP policy: an allowlist per request, checked by Coinbase. |
| **A compromised host running the kit** | Only the CDP policy. It holds **only if** the kit's API key cannot manage policies (step 3) and the admin key is not on that host. Even then, see the limits below. Running the kit as its own OS user keeps other processes on the host from reading its credentials and ledger. |

**What the CDP policy does not do.**
- **It is per request.** This template has no aggregate, rolling or daily limit. A compromised host
  can send allowlisted transactions one after another, up to the per-transaction caps each time,
  until the wallet is empty. The kit's 24-hour cap lives in the kit's ledger, which that host can
  also delete. **Keep the wallet funded with only what you are willing to lose.**
  - CDP's simulation docs and API types mention a `rateLimiting` criterion: a count or USD total per
    window, counted across the project. But no published reference for it exists, and CDP SDK 1.60's
    policy schema cannot create one, so this template does not use it. If CDP documents it for your
    project, a project-scoped USD rate limit is the aggregate fence this policy lacks.
- **It only sees what CDP signs.** Its accept rules cover only the pinned contracts and functions;
  anything else on the governed operations is rejected by default. It cannot judge prices: an
  allowlisted swap at a terrible price passes. The kit's reference floor is what judges price.
- **Undocumented: detaching the policy.** CDP's documentation does not say whether changing an
  account's policy (`updateAccount`, which takes the wallet secret the kit holds) needs the
  policy-management restriction. Check it yourself: with the kit's key, try to detach or replace the
  policy. It must fail. If it succeeds, the policy is not a fence against a compromised host.
- **EIP-7702 delegation** (`createEvmEip7702Delegation`) is not one of the operations CDP's policy
  rules govern in SDK 1.60, so a policy cannot forbid it. The kit never calls it.
- **A project-level policy takes precedence** over the account policy when any of its rules match.
  Make sure no project-level policy accepts these operations broadly.

**Other limits.**
- The kit does not decide whether a route is the best price. It enforces "no worse than the
  reference, less the slippage cap", and its caps bound the rest.
- The game server is authoritative for game state and payouts.
- The reference is router v1's own route, over pools the routers' owner registers. The registry is
  re-read entry by entry before every swap, and the kit stops if it changes.

## Configuration

| Key | Default | Notes |
|---|---|---|
| `signer` | (required) | `{ "type": "cdp", "accountName": "…", "credentialsFile": "…" }` (recommended), or `{ "type": "local-test", "keyFile": "…", "acknowledgeTestOnly": true }`. Without `credentialsFile`, the CDP SDK reads `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET` and `CDP_WALLET_SECRET` from the environment. |
| `rpcUrl` / `rpcUrlFile` | `https://mainnet.base.org` | Use `rpcUrlFile` for a keyed URL, so the key is not in the config. It must be https (http only on localhost), and it must support `eth_call` state overrides. Only the host is ever logged. |
| `limits.maxSlippageBps` | 100 | 1 to 500 |
| `limits.maxTxUsd` | 5 | per swap |
| `limits.maxDailyUsd` | 20 | per rolling 24 hours; must be at least `maxTxUsd` |
| `limits.maxDeadlineSeconds` | 1800 | 60 to 3600 |
| `limits.maxGasPerTx` | 2500000 | gas limit cap per transaction (100,000 to 10,000,000). The v1 entry swap used 1,153,765 on a fork; at the 0.5 gwei fee cap, 2.5M gas costs at most 0.00125 ETH (about $2.80 at $2,250/ETH). |
| `limits.maxFeePerGasGwei` | 0.5 | maxFeePerGas cap |
| `ledgerPath` | `~/.mineswap-agent-kit/spend-ledger.json` | |
| `ledgerSentinelPath` | `~/.config/mineswap-agent-kit/spend-ledger.sentinel` | must be in a different directory from the ledger |

**CDP telemetry.** The CDP SDK sends usage and error telemetry unless told otherwise. The kit sets
`DISABLE_CDP_USAGE_TRACKING=true` and `DISABLE_CDP_ERROR_REPORTING=true` unless you set them
yourself, for example to `false` to opt back in.

**The local key signer is for testing only**, on a fork or a throwaway wallet. It reads a plain
private key from a file and prints a warning on every start.

### Resetting the spend ledger

The ledger and its sentinel are kept in two directories, and they must agree. The kit refuses every
swap until they do when the ledger:
- is deleted after it was created;
- is restored from an older copy;
- is corrupt.

To reset the 24-hour cap on purpose:
1. Stop the kit.
2. Delete **both** `ledgerPath` and `ledgerSentinelPath`.
3. Start the kit.

Deleting both files is the only reset, and anyone who can delete both can reset the cap. That is one
more reason to run the kit as its own user.

**A lock-break marker left by a crash.** Two kit processes on one ledger take turns through a lock
file next to it, `<ledgerPath>.lock`. A lock left by a crashed process is broken automatically,
once it is 30 seconds old and its process is gone, under a second marker, `<ledgerPath>.lock.break`.
That marker exists for microseconds. If a crash ever leaves it behind, every swap is refused with a
message naming it until you:
1. stop every kit process;
2. delete `<ledgerPath>.lock.break`.

## The CDP wallet policy (owner step)

`policies/cdp-wallet-policy.json` is a template for a CDP account policy. Rendered for one wallet, it
is the kit's allowlist, enforced by Coinbase for that account.
- **Accept rules** for `sendEvmTransaction`, on Base only:
  - `approve` on USDC to the two routers, capped at `--max-tx-usd`;
  - `approve` on BG to router v1 and MineBurnEntry only (never router v2), capped at `--max-bg`;
  - `approve` on WETH to the two routers, capped at `--max-weth`;
  - v1 `swapExactInPath` and `swapExactTokensForTokens`, and v2 `swapExactIn` and `swapExactOut`,
    each with the recipient fixed to the agent wallet and a `netUSDChange` cap of `--max-tx-usd`;
  - MineBurnEntry `activate()`.
- **Accept rules** for `signEvmMessage`: the two login formats, with the agent wallet's address
  pinned in each pattern.
- **How everything else is refused.** CDP rejects a request when the policy has rules for its
  operation and none of them match. A matching reject rule overrides any accept, so the template has
  **no** catch-all rejects for the two operations above. It does have explicit rejects for every
  operation the kit never uses: `signEvmTransaction` (sign-without-send), `signEvmTypedData`,
  `signEvmHash`, `prepareUserOperation` and `sendUserOperation`.
- **What the policy cannot see: which token a v2 swap sells.** CDP's `evmData` criterion reads only
  top-level arguments of primitive types, and v2's `tokenIn` sits inside its `plan` tuple, so no rule
  can name it. A BG-selling v2 swap is still stopped, one step removed:
  - the policy never lets BG be approved to router v2;
  - v2 pulls its input with `transferFrom` from the wallet;
  - so a v2 swap selling BG reverts for lack of allowance, and CDP's simulation of it fails closed.
  The kit itself refuses BG-input v2 swaps outright.

**Token-unit ceilings.** `--max-bg`, `--max-weth` and `--max-eth` are in token units, not USD, and
do not follow prices. Their defaults are 1 BG, 0.002 WETH and 0.002 ETH. Set them from today's price
for your USD cap.

To apply it, using the ADMIN key:

1. **Render it for your agent wallet** (the address `wallet_status` shows). Use the same
   per-transaction cap as the kit config. This step only renders, then validates against the CDP
   SDK's own schema; it calls no API.

   ```bash
   node scripts/render-cdp-policy.mjs 0xYourAgentWallet --max-tx-usd 5 --max-bg 1 --max-weth 0.002 --max-eth 0.002 > policy.json
   ```

2. **Create the policy and attach it to the account**, either:
   - in the CDP portal (Wallets → Policies: create an account policy from `policy.json`, then assign
     it to the account); or
   - with the SDK:

   ```js
   import { CdpClient } from '@coinbase/cdp-sdk';
   import { readFileSync } from 'node:fs';
   const cdp = new CdpClient(); // the ADMIN key
   const policy = await cdp.policies.createPolicy({ policy: JSON.parse(readFileSync('policy.json', 'utf8')) });
   await cdp.evm.updateAccount({ address: '0xYourAgentWallet', update: { accountPolicy: policy.id } });
   ```

3. **Check that it does what the kit expects, without sending anything.** The check script runs CDP's
   policy simulator over **every legitimate operation the kit performs** (12 cases, each must come
   back `accept`) and a set of hostile ones (15, each must come back `reject`). The hostile ones
   include a BG approval to router v2, a v2 swap selling BG, and a user operation. It signs and
   sends nothing, and exits 1 on any mismatch.

   ```bash
   CDP_API_KEY_ID=… CDP_API_KEY_SECRET=… node scripts/check-cdp-policy.mjs 0xYourAgentWallet
   ```

   - **The four swap accepts are INCONCLUSIVE from an unfunded wallet.** Their `netUSDChange`
     criterion makes CDP simulate the real swap from the wallet as it stands. The simulator takes no
     balance or allowance input, so without the input token and its approval the swap reverts, and
     CDP answers `422 transaction_simulation_failed`, meaning the real operation would fail closed.
     The script prints those cases as `INCONCLUSIVE` and does not count them as mismatches; the
     neighbouring reject cases still exercise every other criterion of their rules. A real swap is
     sent after its exact approval, so CDP can simulate it then.
   - **A 422 on a reject case is a pass**: the real operation fails closed too.
   - **A 404 on the user-operation case is also a pass**: the account is not a smart account, so CDP
     cannot run user operations for it at all.

4. **Prove the kit's key cannot change the policy.** Using the kit's key, try `cdp.policies.updatePolicy`
   and `cdp.evm.updateAccount` to detach it. Both must fail.

## What the owner must set

- The CDP project; the kit's API key without policy management, in a 0600 credentials file owned by
  the kit's OS user; and a separate admin key, kept elsewhere.
- A funded agent wallet, holding only what you are willing to lose.
- The caps in the kit config, and the same per-transaction cap in the rendered CDP policy.
- The CDP wallet policy, applied and checked (both steps 3 and 4 above).
- An RPC URL if you do not want the public `mainnet.base.org`. Use `rpcUrlFile` for a keyed one; it
  must support `eth_call` state overrides.

## How the game login works

`login` signs mineswap.app's war-auth challenge and posts
`{ wallet, tokenId, mineType: "goldmine", signature, message, timestamp }` to `/api/war-auth`. The
challenge is:

```
www.mineswap.app wants you to sign in with your Ethereum account:
<checksummed wallet>

Sign in to MineSwap to play your Gold Mine #<mine id>. This is a free signature, not a transaction; it can't move your tokens or NFTs, and it expires in 5 minutes.

URI: https://www.mineswap.app
Version: 1
Chain ID: 8453
Nonce: <random>
Issued At: <now, ISO>
Expiration Time: <now + 5 min, ISO>
```

The server matches this message exactly.

**Statement change (2026-11-02).** Kits before this date sign the statement
`BaseGold war session for goldmine #<mine id> (stack -).` mineswap.app still accepts that wording for
now, so an older kit keeps logging in. This kit signs only the new one, and the CDP policy template
accepts both: **re-render and re-apply the policy (step 7) before you upgrade the kit**, or CDP will
refuse the new login message under a policy rendered from an older template. It then checks `ownerOf`, consumes the signature once, and
returns a 24-hour bearer token, which the kit keeps in memory only.

`login` does **not** create an `/api/session` play session. While that session's heartbeat is fresh,
every `/api/agent` write answers 409 `sessionConflict` for 60 seconds, so creating one would block
the agent itself; the agent API needs only the war-auth token.

The play-session message is still allowlisted, for a caller that wants that lock on purpose
(`GameClient.createPlaySession`). It is the same SIWE shape with the statement
`MineSwap play session for this device.` (or, for a takeover,
`MineSwap play session for this device, replacing the session on any other device.`). The older
`BaseGold Miner Session` text is refused by mineswap.app and by the kit.

## Development

```bash
npm run typecheck
npm test            # hostile calldata, reference floor, caps, ledger, approvals, login messages, 429 back-off, MCP schemas, game API (mocked)
npm run build
```

The fork rehearsal runs the real `buy_bg` and `activate_mine` tools against the real contracts, on
an anvil fork of Base, from a fresh key. It moves the USDC/WETH hop pool between quoting and
executing:

```bash
FORK_RPC_URL_FILE=/path/to/file-with-a-base-rpc-url node scripts/fork-rehearsal.mjs <out-dir>
```

The game API cannot be rehearsed on a fork: the production game reads mainnet and uses server
secrets. Its steps are covered by mocked tests (`test/game.test.ts`) that mirror the route handlers.
