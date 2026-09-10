'use client';

// Data layer. react-query owns server state; components own UI state.
//
// That split is deliberate. MECHANICS §4.10's unkillable banner was caused by a
// polling effect resetting a locally-dismissed piece of UI every eight seconds.
// Nothing here writes component state, so a refetch can never resurrect
// something the user dismissed.
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api, type Health, type RfqDetail, type Balances, type Asset } from '@/lib/api';
import { socket, type WsStatus } from '@/lib/ws';
import type { Rfq, RfqStatus, WsFrame } from '@sotto/shared';

export const qk = {
  health: ['health'] as const,
  rfqs: (status?: RfqStatus) => ['rfqs', status ?? 'all'] as const,
  rfq: (id: string) => ['rfq', id] as const,
  balances: (account: string) => ['balances', account.toLowerCase()] as const,
  assets: ['assets'] as const,
};

export function useHealth(): UseQueryResult<Health> {
  return useQuery({
    queryKey: qk.health,
    queryFn: api.health,
    refetchInterval: 15_000,
    staleTime: 5_000,
    retry: 1,
  });
}

export function useAssets(): UseQueryResult<Asset[]> {
  return useQuery({ queryKey: qk.assets, queryFn: api.assets, staleTime: 30_000 });
}

export function useRfqs(status?: RfqStatus): UseQueryResult<Rfq[]> {
  return useQuery({
    queryKey: qk.rfqs(status),
    queryFn: () => api.listRfqs(status),
    refetchInterval: 8_000,
  });
}

export function useRfq(id: string | null | undefined): UseQueryResult<RfqDetail> {
  return useQuery({
    queryKey: qk.rfq(id ?? ''),
    queryFn: () => api.getRfq(id as string),
    enabled: Boolean(id),
    refetchInterval: 5_000,
  });
}

export function useBalances(account: string | null | undefined): UseQueryResult<Balances> {
  return useQuery({
    queryKey: qk.balances(account ?? ''),
    queryFn: () => api.balances(account as string),
    enabled: Boolean(account),
    refetchInterval: 6_000,
  });
}

/** Live connection status, for the header lamp. */
export function useWsStatus(): WsStatus {
  const [status, setStatus] = useState<WsStatus>(socket.status);
  useEffect(() => socket.onStatus(setStatus), []);
  return status;
}

/**
 * Mount once, near the root. Every §3.5 frame invalidates exactly the queries it
 * affects, so a settlement lands on screen the instant consensus reports it
 * rather than on the next poll.
 */
export function useLiveUpdates(onFrame?: (frame: WsFrame) => void) {
  const qc = useQueryClient();

  useEffect(() => {
    return socket.onFrame((frame) => {
      switch (frame.type) {
        case 'rfq.updated':
          qc.setQueryData(qk.rfq(frame.rfq.id), (prev: RfqDetail | undefined) =>
            prev ? { ...prev, rfq: frame.rfq } : prev
          );
          qc.invalidateQueries({ queryKey: ['rfqs'] });
          break;
        case 'quote.committed':
        case 'window.closed':
        case 'quote.revealed':
        case 'awarded':
        case 'audit':
          qc.invalidateQueries({ queryKey: qk.rfq(frame.type === 'audit' ? frame.event.rfqId : frame.rfqId) });
          break;
        case 'settled':
        case 'reverted':
          qc.invalidateQueries({ queryKey: qk.rfq(frame.rfqId) });
          qc.invalidateQueries({ queryKey: ['rfqs'] });
          // Both ledgers must move in the same instant. Refresh every balance.
          qc.invalidateQueries({ queryKey: ['balances'] });
          break;
      }
      onFrame?.(frame);
    });
  }, [qc, onFrame]);
}

/** Subscribe to one RFQ's stream for as long as the component is mounted. */
export function useRfqSubscription(rfqId: string | null | undefined) {
  // One shared browser socket serves every screen, so keep it unfiltered.
  // The backend's subscription command stores only one filter per socket.
  void rfqId;
}

/** A ticking clock, for countdowns. One interval, shared shape. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
