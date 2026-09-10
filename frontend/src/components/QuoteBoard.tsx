'use client';

// B2 — the live RFQ board. "Dealer count and commit count during the window,
// prices hidden. Show locked padlocks with commit hashes. When the window
// closes, reveal them one by one. This is the visual centrepiece."
//
// The privacy claim is made by what this component REFUSES to render. While the
// window is open it has no price to show, because the venue does not have one:
// the wire only ever carried keccak256(price, quantity, nonce, dealer). The
// §3.5 `quote.committed` frame deliberately has no price field. That is the
// substitution for Canton's native privacy and it is the honest version of it.
//
// The firmness column comes from `QuoteReveal.validUntil` (START-HERE §3): a
// dealer's price is firm for a stated window measured from its own HCS
// consensus timestamp, not for as long as the seller feels like waiting.
// A stale quote cannot be awarded — that free option was never written.
import { useMemo } from 'react';
import { Panel, Empty } from '@/components/ui/Panel';
import { Addr } from '@/components/ui/Addr';
import { Button } from '@/components/ui/Button';
import { Num } from '@/components/ui/Num';
import { Countdown } from '@/components/ui/Status';
import { useNow } from '@/hooks/useApi';
import { formatBps, formatClock, countdown } from '@/lib/format';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';
import type { Rfq, QuoteCommit, QuoteReveal } from '@sotto/shared';

interface Props {
  rfq: Rfq;
  commits: QuoteCommit[];
  reveals: QuoteReveal[];
  cashDecimals: number;
  /** Oracle mark, for the off-market annotation. */
  nav?: string | null;
  awardedDealer?: string | null;
  /** Seller-only. Absent for a dealer looking at the same board. */
  onAward?: () => void;
  awarding?: boolean;
}

export function QuoteBoard({
  rfq, commits, reveals, cashDecimals, nav, awardedDealer, onAward, awarding,
}: Props) {
  const now = useNow();
  const sealed = rfq.status === 'OPEN';

  const revealByDealer = useMemo(() => {
    const m = new Map<string, QuoteReveal>();
    for (const r of reveals) m.set(r.dealer.toLowerCase(), r);
    return m;
  }, [reveals]);

  const rows = useMemo(() => {
    const list = commits.map((c) => ({
      commit: c,
      reveal: revealByDealer.get(c.dealer.toLowerCase()) ?? null,
    }));
    if (sealed) {
      // While sealed there is nothing to rank by. Consensus order is the only
      // ordering the venue legitimately knows.
      return list.sort((a, b) => (a.commit.hcsSequenceNumber ?? 0) - (b.commit.hcsSequenceNumber ?? 0));
    }
    return list.sort((a, b) => {
      const av = a.reveal?.valid ? BigInt(a.reveal.price) : -1n;
      const bv = b.reveal?.valid ? BigInt(b.reveal.price) : -1n;
      if (av === bv) {
        // BLUEPRINT A4: ties break on the earliest HCS sequence number.
        return (a.commit.hcsSequenceNumber ?? 0) - (b.commit.hcsSequenceNumber ?? 0);
      }
      return bv > av ? 1 : -1;
    });
  }, [commits, revealByDealer, sealed]);

  const bestDealer = useMemo(() => {
    const valid = reveals.filter((r) => r.valid);
    if (!valid.length) return null;
    return valid.reduce((a, b) => (BigInt(b.price) > BigInt(a.price) ? b : a)).dealer.toLowerCase();
  }, [reveals]);

  const anyFirm = reveals.some((r) => r.valid && r.validUntil > now);

  return (
    <Panel
      title="Quotes"
      subtitle={
        sealed
          ? 'Sealed. The venue holds hashes, not prices — nobody can read a quote, including us.'
          : 'Revealed. Each price was recomputed against its commit hash and must match exactly.'
      }
      right={
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-baseline gap-1.5">
            <span className="label">dealers</span>
            <span className="num text-txt">{commits.length}</span>
          </span>
          {sealed ? (
            <Countdown deadline={rfq.commitDeadline} label="closes in" />
          ) : rfq.status === 'REVEALING' ? (
            <Countdown deadline={rfq.revealDeadline} label="reveal ends" />
          ) : null}
          {onAward && rfq.status === 'REVEALING' && !awardedDealer && (
            <Button
              variant="primary"
              onClick={onAward}
              busy={awarding}
              disabled={!anyFirm || awarding}
              title="Allocate by price priority, then HCS order for ties"
            >
              Allocate book
            </Button>
          )}
        </div>
      }
      bodyClassName={rows.length ? 'p-0' : 'p-4'}
    >
      {rows.length === 0 ? (
        <Empty>
          No quotes yet.{' '}
          {sealed ? 'Dealers have until the window closes to commit.' : 'This RFQ drew no interest.'}
        </Empty>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-line">
              <Th className="w-8" />
              <Th>Dealer</Th>
              <Th>{sealed ? 'Commit hash' : 'Price'}</Th>
              {!sealed && <Th className="hidden md:table-cell">vs NAV</Th>}
              {!sealed && <Th className="hidden lg:table-cell">Firm for</Th>}
              <Th className="hidden sm:table-cell">HCS</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ commit, reveal }, i) => {
              const d = commit.dealer.toLowerCase();
              const isBest = !sealed && bestDealer === d && reveal?.valid;
              const isAwarded = awardedDealer?.toLowerCase() === d;
              const firm = Boolean(reveal?.valid && reveal.validUntil > now);
              const forfeit = !sealed && rfq.status !== 'REVEALING' && !reveal;

              return (
                <tr
                  key={commit.dealer}
                  style={{ animationDelay: `${i * 90}ms` }}
                  className={cn(
                    'border-b border-line/60 last:border-0',
                    !sealed && 'animate-unlock',
                    isAwarded && 'bg-pos/[0.06]',
                    isBest && !isAwarded && 'bg-held/[0.05]'
                  )}
                >
                  <Td>
                    <Padlock open={!sealed && Boolean(reveal)} valid={reveal?.valid} />
                  </Td>

                  <Td>
                    <div className="flex items-center gap-2">
                      <Addr value={commit.dealer} href={hashscan.account(commit.dealer)} />
                      {isAwarded && (
                        <span className="text-2xs text-pos border border-pos/40 rounded px-1">
                          awarded
                        </span>
                      )}
                      {isBest && !isAwarded && (
                        <span className="text-2xs text-held border border-held/40 rounded px-1">
                          best
                        </span>
                      )}
                    </div>
                  </Td>

                  <Td>
                    {sealed ? (
                      <span className="font-mono text-xs text-dim" title={commit.commitHash}>
                        {commit.commitHash.slice(0, 18)}…
                      </span>
                    ) : reveal ? (
                      reveal.valid ? (
                        <div>
                          <Num
                            value={reveal.price}
                            decimals={cashDecimals}
                            kind="price"
                            className={cn('text-base', isBest ? 'text-held font-medium' : 'text-txt')}
                          />
                          <div className="mt-0.5 text-2xs text-dim">
                            {reveal.quantity} units · minimum {reveal.minQuantity}
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-neg">
                          reveal did not match its commit — void
                        </span>
                      )
                    ) : forfeit ? (
                      <span className="text-xs text-dim">
                        never revealed — forfeit
                      </span>
                    ) : (
                      <span className="text-xs text-dim">awaiting reveal…</span>
                    )}
                  </Td>

                  {!sealed && (
                    <Td className="hidden md:table-cell">
                      {reveal?.valid && nav ? (
                        <span
                          className={cn(
                            'text-xs num',
                            formatBps(reveal.price, nav) === 'off market' ? 'text-neg' : 'text-muted'
                          )}
                        >
                          {formatBps(reveal.price, nav)}
                        </span>
                      ) : (
                        <span className="text-xs text-dim">—</span>
                      )}
                    </Td>
                  )}

                  {!sealed && (
                    <Td className="hidden lg:table-cell">
                      {reveal?.valid ? (
                        firm ? (
                          <span className="text-xs num text-muted" title={formatClock(reveal.validUntil)}>
                            {countdown(reveal.validUntil, now)}
                          </span>
                        ) : (
                          <span className="text-xs text-neg" title={formatClock(reveal.validUntil)}>
                            stale
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-dim">—</span>
                      )}
                    </Td>
                  )}

                  <Td className="hidden sm:table-cell">
                    <span className="font-mono text-2xs text-dim">
                      {commit.hcsSequenceNumber != null ? `#${commit.hcsSequenceNumber}` : '—'}
                    </span>
                  </Td>

                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {!sealed && onAward && !awardedDealer && reveals.some((r) => r.valid) && !anyFirm && (
        <p className="px-4 py-3 border-t border-line text-xs text-neg">
          Every revealed quote has passed its firmness window. Nothing here can be awarded — a
          dealer's price is firm for a stated period from its own consensus timestamp, and holding
          them past it would be a free option they never wrote.
        </p>
      )}
    </Panel>
  );
}

function Padlock({ open, valid }: { open: boolean; valid?: boolean }) {
  if (!open) {
    return (
      <span title="Sealed — the venue holds only a hash" className="text-dim" aria-label="sealed">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="10" width="16" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      </span>
    );
  }
  return (
    <span
      title={valid ? 'Revealed and verified against its commit' : 'Reveal did not match its commit'}
      className={cn('animate-unlock', valid ? 'text-pos' : 'text-neg')}
      aria-label={valid ? 'revealed' : 'void'}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 7.5-2" />
      </svg>
    </span>
  );
}

const Th = ({ children, className }: { children?: React.ReactNode; className?: string }) => (
  <th className={cn('label font-medium px-4 py-2', className)}>{children}</th>
);

const Td = ({ children, className }: { children?: React.ReactNode; className?: string }) => (
  <td className={cn('px-4 py-3 align-middle', className)}>{children}</td>
);
