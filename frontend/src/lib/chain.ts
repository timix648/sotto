import { defineChain } from 'viem';
import { CHAIN_ID, JSON_RPC_URL, HASHSCAN_BASE } from './config';

/** Hedera testnet, as viem/wagmi want it. BLUEPRINT B0. */
export const hederaTestnet = defineChain({
  id: CHAIN_ID,
  name: 'Hedera Testnet',
  nativeCurrency: { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls: { default: { http: [JSON_RPC_URL] } },
  blockExplorers: { default: { name: 'HashScan', url: HASHSCAN_BASE } },
  testnet: true,
});
