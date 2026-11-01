/**
 * @mineswap/agent-kit — library entry. Raw signers are deliberately NOT exported: the only signing
 * object a caller can obtain is the GuardedWallet that createKit() builds after verifying the pins.
 */
export { createKit, type Kit, type KitOverrides } from './kit.js';
export { loadConfigFile, resolveConfig, ConfigSchema, type ResolvedConfig } from './config.js';
export { GuardedWallet, authorizeTransaction, type PreparedSwap, type SwapResult, type TxBinding } from './guard/wallet.js';
export { decodeIntent, type Intent, type SwapIntent, type ApproveIntent, type TxRequest } from './guard/decode.js';
export { checkSwap, checkSlippage, checkApproval, checkCaps, usdcToCents, weiToCents, centsToUsd, DEFAULT_LIMITS, HARD_MAX_SLIPPAGE_BPS, type Limits, type SwapExpectation } from './guard/policy.js';
export { authorizeMessage, buildWarAuthMessage, buildSessionMessage } from './guard/messages.js';
export { GuardRefusal, isGuardRefusal, type RefusalCode } from './guard/refusal.js';
export { verifyPins, assertPins, type PinReport } from './guard/verify-pins.js';
export { readRouterState, assertRouterState, type StateCheck } from './guard/router-state.js';
export { KitIncident, isKitIncident, type IncidentCode } from './guard/incident.js';
export { FileLedger, MemoryLedger, type SpendLedger } from './guard/ledger.js';
export { DexClient, buyBg, swap, previewSwap, parseQuoteResponse, QuoteRefused } from './dex.js';
export { GameClient, GameApiError, UPGRADE_IDS, EXPEDITION_TYPES } from './game.js';
export { HttpClient, RateLimitedError, HttpError } from './http.js';
export { createMcpServer, TOOL_SCHEMAS, type ToolName } from './mcp/server.js';
export * as pins from './pins.js';
export { REPO_URL, SECURITY_REPORT_URL } from './project.js';
