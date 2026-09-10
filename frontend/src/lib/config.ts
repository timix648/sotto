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

export const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

/** Port 4010 is the fixture mock; 4000 is the live testnet API. */
export const LOOKS_LIKE_MOCK_PORT = /:4010(\/|$)/.test(API_BASE);

/**
 * Decimals. USDC is 6 (START-HERE §2). The bond's decimals come from the API
 * with the asset; this is only the fallback when an asset has not loaded yet.
 */
export const DEFAULT_CASH_DECIMALS = 6;
export const DEFAULT_ASSET_DECIMALS = 0;
