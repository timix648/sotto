'use client';

import { useLiveUpdates } from '@/hooks/useApi';

/** Mounts the single WebSocket subscription for the whole app. Renders nothing. */
export function LiveUpdates() {
  useLiveUpdates();
  return null;
}
