'use client';

// The venue-wide audit trail — the 3:50–4:15 beat of the demo script.
//
// "Every commit hash timestamped before any price was readable. The audit trail
// is what makes a public chain safe for block trades."
//
// The claim is checkable rather than asserted: the commit rows carry sequence
// numbers strictly lower than the reveal rows for the same request, and every
// row links to the same HCS topic on HashScan.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Panel, Empty } from '@/components/ui/Panel';
import { Addr, HashScanLink } from '@/components/ui/Addr';
import { StatusPill } from '@/components/ui/Status';
import { AuditTimeline } from '@/components/AuditTimeline';
import { Shell } from '@/components/layout/Shell';
import { useHealth, useRfqs, useRfq } from '@/hooks/useApi';
import { hashscan } from '@/lib/hashscan';
import { formatQty } from '@/lib/format';
import { cn } from '@/lib/cn';

export default function AuditPage() {
  const { data: health } = useHealth();
  const { data: rfqs } = useRfqs();
  const [selected, setSelected] = useState<string | null>(null);

  const ordered = useMemo(
    () => [...(rfqs ?? [])].sort((a, b) => b.createdAt - a.createdAt),
    [rfqs]
  );
  const current = selected ?? ordered[0]?.id ?? null;
  const { data: detail } = useRfq(current);

  return (
    <Shell className="space-y-5">
      <div className="max-w-3xl">
        <h1 className="text-base font-medium text-txt">Audit trail</h1>
        <p className="mt-1.5 text-sm text-muted leading-relaxed">
          Every stage of every request is written to one Hedera Consensus Service topic. The
          sequence numbers are the venue&apos;s integrity claim: a commit hash is timestamped by the
          network before any price behind it could be read, and the quote window closes on a
          consensus timestamp rather than on our server clock. The venue is auditable without
          being transparent while the auction is live.
        </p>
        {health?.topicId && (
          <div className="mt-3">
            <HashScanLink href={hashscan.topic(health.topicId)}>
              Read the raw topic on HashScan — {health.topicId}
            </HashScanLink>
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Panel title="Requests" subtitle="Newest first" bodyClassName={ordered.length ? 'p-0' : 'p-4'}>
            {!ordered.length ? (
              <Empty>Nothing has been written to the topic yet.</Empty>
            ) : (
              <ul className="max-h-[32rem] overflow-y-auto">
                {ordered.map((r) => (
                  <li key={r.id} className="border-b border-line/60 last:border-0">
                    <button
                      onClick={() => setSelected(r.id)}
                      className={cn(
                        'w-full px-4 py-3 text-left transition-[transform,background-color] duration-200 hover:translate-x-0.5 focusable',
                        r.id === current ? 'bg-raised' : 'hover:bg-wineWash'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm text-txt">{r.assetSymbol}</span>
                        <StatusPill status={r.status} />
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-2 text-2xs text-dim">
                        <span className="num">{formatQty(r.quantity, 0)} units</span>
                        {r.hcsSequenceNumber != null && (
                          <span className="font-mono">from HCS #{r.hcsSequenceNumber}</span>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="lg:col-span-3">
          <Panel
            title="Consensus record"
            subtitle={current ? 'Ordered by HCS sequence number' : undefined}
            right={
              current ? (
                <Link href={`/rfq/${current}`} className="text-xs text-txt underline underline-offset-2 decoration-line hover:decoration-current focusable rounded">
                  Settlement view →
                </Link>
              ) : null
            }
          >
            {!current ? (
              <Empty>Select a request.</Empty>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                  <span className="flex items-center gap-1.5">
                    <span className="label">request</span>
                    <Addr value={current} />
                  </span>
                  {detail?.rfq && (
                    <span className="flex items-center gap-1.5">
                      <span className="label">seller</span>
                      <Addr value={detail.rfq.seller} href={hashscan.account(detail.rfq.seller)} />
                    </span>
                  )}
                </div>
                <AuditTimeline
                  events={detail?.audit ?? []}
                  cashDecimals={health?.cashDecimals ?? 6}
                  assetSymbol={detail?.rfq.assetSymbol}
                />
              </>
            )}
          </Panel>
        </div>
      </div>
    </Shell>
  );
}
