'use client';

import Link from 'next/link';
import { Panel, Empty } from '@/components/ui/Panel';
import { StatusPill, Countdown } from '@/components/ui/Status';
import { Addr } from '@/components/ui/Addr';
import { formatQty, formatClock } from '@/lib/format';
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
                  'flex items-center gap-4 px-4 hover:bg-raised/60 transition-colors focusable',
                  dense ? 'py-2.5' : 'py-3.5'
                )}
              >
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
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
