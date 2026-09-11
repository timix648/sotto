// Runtime configuration.
//
// RULE, from START-HERE §2 and BLUEPRINT B0: contract addresses are NEVER
// hardcoded here. They are served by GET /api/health so that a redeploy or a
// testnet reset does not require a frontend change. The only addresses this
// file knows are the ones the *network* defines (chain id, relay, explorer).

export const CHAIN_ID = 296; // Hedera testnet
export const JSON_RPC_URL = 'https://testnet.hashio.io/api';
export const HASHSCAN_BASE = 'https://hashscan.io/testnet';

const trimSlash = (s: string) => s.replace(/\/+$/, '');

export const API_BASE = trimSlash(
  process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:4000'
);

/** Derive the websocket URL from the API base unless one is given explicitly. */
export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL ||
  trimSlash(API_BASE).replace(/^http/, 'ws') + '/ws';

export const WALLETCONNECT_PROJECT_ID =
  process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '';

/**
 * The origin this app is served from, shown to the user in their wallet's
 * connection prompt.
 *
 * Derived from the browser rather than configured, because a deployment always
 * knows its own origin and an env var can be — and was — wrong. Ours briefly
 * pointed at an unrelated project that happened to own the name we guessed,
 * which would have shown a stranger's domain in the approval dialog. The env
 * var still wins when set, for a deployment that is fronted by a different
 * hostname than it is served from.
 */
export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL
  || (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000');

/** Port 4010 is the fixture mock; 4000 is the live testnet API. */
export const LOOKS_LIKE_MOCK_PORT = /:4010(\/|$)/.test(API_BASE);

/**
 * Decimals. USDC is 6 (START-HERE §2). The bond's decimals come from the API
 * with the asset; this is only the fallback when an asset has not loaded yet.
 */
export const DEFAULT_CASH_DECIMALS = 6;
export const DEFAULT_ASSET_DECIMALS = 0;
