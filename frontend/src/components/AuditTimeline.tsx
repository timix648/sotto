'use client';

// B4 — the vertical timeline, and the whole audit story.
//
// "Every commit hash timestamped before any price was readable. The audit trail
// is what makes a public chain safe for block trades." So every row carries its
// HCS sequence number and its CONSENSUS timestamp — not our clock — and
// consecutive events of one kind collapse into a range (#15–18) exactly as the
// blueprint's sketch of this screen does.
import { useMemo } from 'react';
import { Addr, HashScanLink } from '@/components/ui/Addr';
import { formatConsensus, formatCash, formatPrice, formatQty, truncate } from '@/lib/format';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';
import type { AuditEvent, AuditKind } from '@sotto/shared';

const KIND_LABEL: Record<AuditKind, string> = {
  RFQ_OPENED: 'RFQ opened',
  HOLD_PLACED: 'Hold placed',
  QUOTE_COMMITTED: 'Quotes committed',
  WINDOW_CLOSED: 'Window closed',
  QUOTE_REVEALED: 'Quotes revealed',
  REVEAL_FAILED: 'Reveal rejected',
  AWARDED: 'Awarded',
  SETTLED: 'Settled atomically',
  SETTLEMENT_REVERTED: 'Settlement reverted',
  EXPIRED: 'Expired',
  REDEEMED: 'Redeemed',
};

const KIND_TONE: Record<AuditKind, string> = {
  RFQ_OPENED: 'text-muted border-line',
  HOLD_PLACED: 'text-held border-held/50',
  QUOTE_COMMITTED: 'text-muted border-line',
  WINDOW_CLOSED: 'text-muted border-line',
  QUOTE_REVEALED: 'text-txt border-lineBright',
  REVEAL_FAILED: 'text-neg border-neg/50',
  AWARDED: 'text-held border-held/50',
  SETTLED: 'text-pos border-pos/50',
  SETTLEMENT_REVERTED: 'text-neg border-neg/50',
  EXPIRED: 'text-dim border-line',
  REDEEMED: 'text-pos border-pos/50',
};

interface Group {
  kind: AuditKind;
  events: AuditEvent[];
  first: AuditEvent;
  last: AuditEvent;
}

function groupEvents(events: AuditEvent[]): Group[] {
  const sorted = [...events].sort((a, b) => a.hcsSequenceNumber - b.hcsSequenceNumber);
  const groups: Group[] = [];
  for (const e of sorted) {
    const tail = groups[groups.length - 1];
    if (tail && tail.kind === e.kind) {
      tail.events.push(e);
      tail.last = e;
    } else {
      groups.push({ kind: e.kind, events: [e], first: e, last: e });
    }
  }
  return groups;
}

const str = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;

export function AuditTimeline({
  events, cashDecimals = 6, assetDecimals = 0, assetSymbol, compact,
}: {
  events: AuditEvent[];
  cashDecimals?: number;
  assetDecimals?: number;
  assetSymbol?: string;
  compact?: boolean;
}) {
  const groups = useMemo(() => groupEvents(events), [events]);

  if (!groups.length) {
    return (
      <p className="py-8 text-center text-sm text-dim">
        Nothing on the audit topic for this RFQ yet.
      </p>
    );
  }

  return (
    <ol className="relative">
      {groups.map((g, i) => {
        const last = i === groups.length - 1;
        return (
          <li key={`${g.kind}-${g.first.hcsSequenceNumber}`} className="relative flex gap-3 pb-4 last:pb-0">
            {/* rail */}
            {!last && <span className="absolute bottom-0 left-[5px] top-4 w-0.5 bg-line" aria-hidden />}
            <span
              className={cn(
                'relative z-10 mt-1 h-3 w-3 shrink-0 rounded-full border-[2px] bg-ground',
                KIND_TONE[g.kind] ?? 'text-dim border-line'
              )}
              aria-hidden
            />

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className={cn('text-sm font-medium', (KIND_TONE[g.kind] ?? '').split(' ')[0])}>
                  {KIND_LABEL[g.kind] ?? g.kind}
                </span>
                <span className="font-mono text-2xs text-dim shrink-0">
                  HCS{' '}
                  {g.first.hcsSequenceNumber === g.last.hcsSequenceNumber
                    ? `#${g.first.hcsSequenceNumber}`
                    : `#${g.first.hcsSequenceNumber}–${g.last.hcsSequenceNumber}`}
                </span>
              </div>

              <div className="mt-0.5 text-xs text-muted leading-relaxed">
                <Detail
                  group={g}
                  cashDecimals={cashDecimals}
                  assetDecimals={assetDecimals}
                  assetSymbol={assetSymbol}
                />
              </div>

              {!compact && (
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    className="font-mono text-2xs text-dim"
                    title="Hedera Consensus Service timestamp — the network's clock, not ours"
                  >
                    {formatConsensus(g.last.consensusTimestamp)}
                  </span>
                  {(() => {
                    const tx = str(g.last.payload?.txHash);
                    return tx ? <HashScanLink href={hashscan.tx(tx)}>transaction</HashScanLink> : null;
                  })()}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Detail({
  group, cashDecimals, assetDecimals, assetSymbol,
}: {
  group: Group;
  cashDecimals: number;
  assetDecimals: number;
  assetSymbol?: string;
}) {
  const { kind, events, last } = group;
  const p = last.payload ?? {};

  switch (kind) {
    case 'RFQ_OPENED': {
      const q = str(p.quantity);
      return (
        <>
          {q ? `${formatQty(q, assetDecimals)} ${str(p.assetSymbol) ?? assetSymbol ?? ''} put up for bid` : 'Request opened'}
        </>
      );
    }
    case 'HOLD_PLACED': {
      const q = str(p.quantity);
      const escrow = str(p.escrow);
      return (
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          {q ? `${formatQty(q, assetDecimals)} ${assetSymbol ?? ''} escrowed` : 'Block escrowed'}
          {p.holdId != null && <span className="text-dim">· hold #{String(p.holdId)}</span>}
          {escrow && (
            <>
              <span className="text-dim">· escrow agent</span>
              <Addr value={escrow} href={hashscan.contract(escrow)} />
            </>
          )}
        </span>
      );
    }
    case 'QUOTE_COMMITTED':
      return (
        <>
          {events.length} dealer{events.length === 1 ? '' : 's'}, prices sealed — the ledger holds
          only hashes
        </>
      );
    case 'WINDOW_CLOSED':
      return <>No further quotes accepted, on a consensus timestamp rather than our clock</>;
    case 'QUOTE_REVEALED': {
      const prices = events
        .map((e) => str(e.payload?.price))
        .filter((x): x is string => Boolean(x))
        .map((x) => formatPrice(x, cashDecimals));
      return prices.length ? <span className="num">{prices.join(' · ')}</span> : <>Prices revealed</>;
    }
    case 'REVEAL_FAILED':
      return <>A reveal did not recompute to its commit hash. The quote is void.</>;
    case 'AWARDED': {
      const dealer = str(p.dealer);
      const price = str(p.price);
      return (
        <span className="inline-flex flex-wrap items-center gap-x-1.5">
          {dealer && <Addr value={dealer} href={hashscan.account(dealer)} />}
          {price && <span className="num text-txt">@ {formatPrice(price, cashDecimals)}</span>}
        </span>
      );
    }
    case 'SETTLED':
      return (
        <>
          cash → seller │ {assetSymbol ?? 'asset'} → buyer, in one transaction
          {p.path ? ` · Path ${String(p.path)}` : ''}
        </>
      );
    case 'SETTLEMENT_REVERTED':
      return (
        <>
          {str(p.message) ?? str(p.reason) ?? 'Reverted'} — both legs rolled back, neither ledger
          moved
        </>
      );
    case 'EXPIRED':
      return <>No award before expiry. The seller can reclaim the hold directly from ATS.</>;
    case 'REDEEMED':
      return <>The matured security was redeemed and removed from the holder&apos;s position.</>;
    default:
      return <>{truncate(JSON.stringify(p), 60, 0)}</>;
  }
}
