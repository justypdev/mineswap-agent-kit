#!/usr/bin/env node
// Render policies/cdp-wallet-policy.json for ONE agent wallet and validate it with the CDP SDK's own
// schema. Prints the policy body to stdout; it calls no API and needs no credentials.
//
//   node scripts/render-cdp-policy.mjs 0xYourAgentWallet [--max-tx-usd 5] [--max-bg 1] [--max-weth 0.002] [--max-eth 0.002] > policy.json
//
// --max-tx-usd   the USD cap per transaction (netUSDChange on every swap, and the USDC approval
//                ceiling). Keep it equal to the kit's limits.maxTxUsd.
// --max-bg       the BG approval ceiling, in BG (token units, NOT USD).
// --max-weth     the WETH approval ceiling, in WETH (token units, NOT USD).
// --max-eth      the ETH a v1 path swap may carry as value, in ETH (token units, NOT USD).
// The three unit ceilings do not follow prices: set them from today's price for your USD cap.
import { readFileSync } from 'node:fs';
import { CreatePolicyBodySchema } from '@coinbase/cdp-sdk';
import { getAddress, isAddress, parseUnits } from 'viem';

export const DEFAULT_CEILINGS = Object.freeze({ maxTxUsd: 5, maxBg: '1', maxWeth: '0.002', maxEth: '0.002' });

export function renderPolicy(template, wallet, o = {}) {
  if (!isAddress(wallet, { strict: false })) throw new Error('the first argument must be the agent wallet address');
  const c = { ...DEFAULT_CEILINGS, ...o };
  if (!(c.maxTxUsd > 0 && c.maxTxUsd <= 1_000_000)) throw new Error('--max-tx-usd must be a positive number');
  const cents = Math.round(c.maxTxUsd * 100);
  const subs = {
    '<AGENT_WALLET_ADDRESS>': getAddress(wallet),
    '<MAX_USDC_UNITS>': String(BigInt(cents) * 10_000n),
    '<MAX_BG_UNITS>': parseUnits(String(c.maxBg), 18).toString(),
    '<MAX_WETH_UNITS>': parseUnits(String(c.maxWeth), 18).toString(),
    '<MAX_ETH_VALUE_WEI>': parseUnits(String(c.maxEth), 18).toString(),
  };
  let text = JSON.stringify(template);
  for (const [k, v] of Object.entries(subs)) text = text.replaceAll(k, v);
  text = text.replaceAll('"<MAX_TX_USD_CENTS>"', String(cents));
  if (/<[A-Z_]+>/.test(text)) throw new Error(`unfilled placeholder ${/<[A-Z_]+>/.exec(text)[0]}`);
  const policy = JSON.parse(text);
  const parsed = CreatePolicyBodySchema.safeParse(policy);
  if (!parsed.success) throw new Error(`the rendered policy does not validate: ${JSON.stringify(parsed.error.issues).slice(0, 500)}`);
  return policy;
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [wallet, ...rest] = process.argv.slice(2);
  const o = {};
  if (flag(rest, '--max-tx-usd')) o.maxTxUsd = Number(flag(rest, '--max-tx-usd'));
  if (flag(rest, '--max-bg')) o.maxBg = flag(rest, '--max-bg');
  if (flag(rest, '--max-weth')) o.maxWeth = flag(rest, '--max-weth');
  if (flag(rest, '--max-eth')) o.maxEth = flag(rest, '--max-eth');
  const template = JSON.parse(readFileSync(new URL('../policies/cdp-wallet-policy.json', import.meta.url), 'utf8'));
  process.stdout.write(`${JSON.stringify(renderPolicy(template, wallet ?? '', o), null, 2)}\n`);
}
