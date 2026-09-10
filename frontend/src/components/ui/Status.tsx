'use client';

import { cn } from '@/lib/cn';
import { countdown } from '@/lib/format';
import { useNow } from '@/hooks/useApi';
import type { RfqStatus } from '@sotto/shared';

const STATUS_STYLE: Record<RfqStatus, string> = {
  OPEN: 'text-held bg-heldWash border-held/30',
  REVEALING: 'text-held bg-held/10 border-held/30',
  AWARDED: 'text-held bg-held/10 border-held/30',
  SETTLED: 'text-pos bg-pos/10 border-pos/30',
  EXPIRED: 'text-dim bg-raised border-line',
  FAILED: 'text-neg bg-neg/10 border-neg/30',
};

/** Plain words. A judge should not have to learn our vocabulary. */
const STATUS_COPY: Record<RfqStatus, string> = {
  OPEN: 'Quotes sealed',
  REVEALING: 'Revealing',
  AWARDED: 'Awarded',
  SETTLED: 'Settled',
  EXPIRED: 'Expired',
  FAILED: 'Reverted',
};

export function StatusPill({ status, className }: { status: RfqStatus; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-2xs font-medium uppercase tracking-wider',
        STATUS_STYLE[status] ?? STATUS_STYLE.EXPIRED,
        className
      )}
    >
      {(status === 'OPEN' || status === 'REVEALING') && (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulseDot" aria-hidden />
      )}
      {STATUS_COPY[status] ?? status}
    </span>
  );
}

export function Countdown({
  deadline, label, className,
}: {
  deadline: number;
  label?: string;
  className?: string;
}) {
  const now = useNow();
  const left = deadline - now;
  const urgent = left <= 15 && left > 0;
  const done = left <= 0;

  return (
    <span className={cn('inline-flex items-baseline gap-1.5', className)}>
      {label && <span className="label">{label}</span>}
      <span
        className={cn(
          'font-mono text-sm num',
          done ? 'text-dim' : urgent ? 'text-neg' : 'text-txt'
        )}
      >
        {countdown(deadline, now)}
      </span>
    </span>
  );
}

export function Lamp({
  tone, title, label,
}: {
  tone: 'pos' | 'neg' | 'held' | 'dim';
  title?: string;
  label?: string;
}) {
  const color =
    tone === 'pos' ? 'bg-pos' : tone === 'neg' ? 'bg-neg' : tone === 'held' ? 'bg-held' : 'bg-dim';
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <span className={cn('h-1.5 w-1.5 rounded-full', color)} aria-hidden />
      {label && <span className="text-2xs text-muted">{label}</span>}
    </span>
  );
}
