# Security policy

The MineSwap agent kit signs transactions with real funds. Please report anything that could make
it sign something it should not, leak a credential, or bypass its spend caps.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**, or go straight to the [report form][report].

- **Please do not open a public issue for a vulnerability**, and do not post it in discussions or pull requests.
- Include:
  - the kit version or commit;
  - what you did;
  - what the kit signed or refused;
  - a minimal reproduction, if you have one. A failing unit test against `src/guard/` is the most
    useful form.

We aim to acknowledge reports within a few days, and to agree a disclosure date with you. There is
no bug bounty.

## Scope

In scope:
- **the guard**, `src/guard/`: calldata decoding, the policy checks, the reference floor, the
  owner-state check, the spend ledger, the message allowlist and startup pin verification;
- **the signers**, `src/signers/`: the CDP server wallet and the local test key;
- **the CDP wallet policy template**, `policies/cdp-wallet-policy.json`, and its render and check
  scripts;
- **the MCP tools**, `src/mcp/`, and the HTTP client they use.

Out of scope: the MineSwap contracts themselves, mineswap.org and mineswap.app, Coinbase CDP, and
third-party RPC providers.

## What the kit does and does not promise

See the README sections "The safety model" and "What protects what". In short:
- the kit guards against a tricked agent, a hostile quote server and a change to the routers'
  owner-controlled state;
- it trusts its RPC provider;
- against a compromised host, only a correctly scoped CDP wallet policy helps, and that policy
  limits each transaction, not a day's spending.

[report]: https://github.com/justypdev/mineswap-agent-kit/security/advisories/new
