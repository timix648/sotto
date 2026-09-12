'use client';

import Link from 'next/link';
import { Panel, Empty } from '@/components/ui/Panel';
import { StatusPill, Countdown } from '@/components/ui/Status';
import { Addr } from '@/components/ui/Addr';
import { formatQty, formatClock, formatDate } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Rfq } from '@sotto/shared';

export function RfqList({
  rfqs, title, subtitle, emptyMessage, assetDecimals = 0, dense, right,
}: {
  rfqs: Rfq[] | undefined;
  title: string;
  subtitle?: string;
  emptyMessage: string;
  assetDecimals?: number;
  dense?: boolean;
  right?: React.ReactNode;
}) {
  if (!rfqs) {
    return (
      <Panel title={title} subtitle={subtitle} right={right}>
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded bg-raised animate-pulse" />
          ))}
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title={title}
      subtitle={subtitle}
      right={right}
      bodyClassName={rfqs.length ? 'p-0' : 'p-4'}
    >
      {rfqs.length === 0 ? (
        <Empty>{emptyMessage}</Empty>
      ) : (
        <ul>
          {rfqs.map((r) => (
            <li key={r.id} className="border-b border-line/60 last:border-0">
              <Link
                href={`/rfq/${r.id}`}
                className={cn(
                  'px-4 transition-[transform,background-color] duration-200 hover:translate-x-0.5 hover:bg-wineWash focusable',
                  dense ? 'block py-2.5' : 'flex items-center gap-4 py-3.5'
                )}
              >
                {/*
                  Dense rows live in a third of a three-column grid - about
                  290px. The wide layout put a 112px pill, an address and a
                  timestamp beside the symbol, which left roughly 100px for the
                  name and wrapped every field onto its own line. Stacked
                  instead, and without the seller: on the seller's own page
                  every row has the same seller, so it was costing the most
                  space to say the least.
                */}
                {dense ? (
                  <>
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate text-sm font-medium text-txt">
                          {r.assetSymbol}
                        </span>
                        <span className="num shrink-0 text-xs text-muted">
                          {formatQty(r.quantity, assetDecimals)} units
                        </span>
                      </div>
                      <span className="shrink-0"><StatusPill status={r.status} /></span>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-2xs text-dim">
                      <span className="truncate">
                        {r.holdId != null ? `hold #${r.holdId}` : 'no hold'}
                      </span>
                      {r.status === 'OPEN' ? (
                        <Countdown deadline={r.commitDeadline} label="closes" />
                      ) : r.status === 'REVEALING' ? (
                        <Countdown deadline={r.revealDeadline} label="reveal ends" />
                      ) : (
                        <span className="shrink-0 font-mono">{formatDate(r.createdAt)}</span>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="w-28 shrink-0">
                      <StatusPill status={r.status} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-medium text-txt">{r.assetSymbol}</span>
                        <span className="num text-sm text-muted">
                          {formatQty(r.quantity, assetDecimals)} units
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-2xs text-dim">
                        <span>seller</span>
                        <Addr value={r.seller} />
                        {r.holdId != null && <span>· hold #{r.holdId}</span>}
                      </div>
                    </div>

                    <div className="hidden sm:block text-right shrink-0">
                      {r.status === 'OPEN' ? (
                        <Countdown deadline={r.commitDeadline} label="closes" />
                      ) : r.status === 'REVEALING' ? (
                        <Countdown deadline={r.revealDeadline} label="reveal ends" />
                      ) : (
                        <span className="text-2xs text-dim font-mono">{formatClock(r.createdAt)}</span>
                      )}
                    </div>
                  </>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
