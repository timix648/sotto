import { HASHSCAN_BASE } from './config';

/**
 * Every on-chain claim in this UI carries a link to the ledger. A judge should
 * be one click from verifying anything we assert. If a link cannot be built we
 * render no link rather than a broken one.
 */
export const hashscan = {
  tx: (hashOrId: string | null | undefined) =>
    hashOrId ? `${HASHSCAN_BASE}/transaction/${hashOrId}` : null,
  contract: (address: string | null | undefined) =>
    address ? `${HASHSCAN_BASE}/contract/${address}` : null,
  account: (idOrAddress: string | null | undefined) =>
    idOrAddress ? `${HASHSCAN_BASE}/account/${idOrAddress}` : null,
  token: (tokenId: string | null | undefined) =>
    tokenId ? `${HASHSCAN_BASE}/token/${tokenId}` : null,
  topic: (topicId: string | null | undefined) =>
    topicId ? `${HASHSCAN_BASE}/topic/${topicId}` : null,
  schedule: (scheduleId: string | null | undefined) =>
    scheduleId ? `${HASHSCAN_BASE}/schedule/${scheduleId}` : null,
};
