'use client';

// B2 — the position card. START-HERE §6 calls this one of the two things that
// carry the whole demo:
//
//   "Total / Available / Held / Locked as four numbers, animated so that when a
//    hold is placed Available drops and Held rises WHILE TOTAL DOES NOT MOVE.
//    That single animation explains the hold primitive with no narration."
//
// So Total is the anchor of the composition, and when the other two move in
// opposite directions the card says out loud that Total did not. The seller
// keeps earning coupons on the whole position — that is the point of a hold
// rather than a transfer into escrow, and it is what the card has to show.
//
// The numbers come from GET /api/balances/:account, which returns all four
// already computed. START-HERE §4: `balanceOf` alone is AVAILABLE, not total —
// call it directly and placing a hold looks like the seller lost tokens.
import { useEffect, useRef, useState } from 'react';
import { Num, Delta } from '@/components/ui/Num';
import { Addr } from '@/components/ui/Addr';
import { Panel } from '@/components/ui/Panel';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';
import type { AssetPosition, CashPosition } from '@/lib/api';

interface Props {
  position: AssetPosition | null | undefined;
  cash?: CashPosition | null;
  title?: string;
  subtitle?: string;
  loading?: boolean;
  compact?: boolean;
}

const big = (v: string | null | undefined): bigint => {
  try { return BigInt(String(v ?? '0')); } catch { return 0n; }
};

export function BalanceCard({ position, cash, title, subtitle, loading, compact }: Props) {
  const prev = useRef<{ total: bigint; available: bigint; held: bigint } | null>(null);
  const [delta, setDelta] = useState<{ available: bigint; held: bigint } | null>(null);
  const [totalHeld, setTotalHeld] = useState(false);

  const total = big(position?.total);
  const available = big(position?.available);
  const held = big(position?.held);
  const locked = big(position?.locked);

  useEffect(() => {
    if (!position) return;
    const p = prev.current;
    prev.current = { total, available, held };
    if (!p) return;

    const dA = available - p.available;
    const dH = held - p.held;
    if (dA === 0n && dH === 0n) return;

    setDelta({ available: dA, held: dH });
    // The claim worth making on screen: the two legs moved, the total did not.
    setTotalHeld(total === p.total && dA !== 0n && dH !== 0n);

    const t = setTimeout(() => { setDelta(null); setTotalHeld(false); }, 3200);
    return () => clearTimeout(t);
  }, [position, total, available, held]);

  const decimals = position?.decimals ?? 0;

  return (
    <Panel
      title={title ?? 'Position'}
      subtitle={subtitle}
      right={
        position ? (
          <div className="flex items-center gap-3">
            <span className="text-xs font-medium text-txt">{position.symbol}</span>
            <Addr value={position.token} href={hashscan.contract(position.token)} />
          </div>
        ) : null
      }
    >
      {loading && !position ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line rounded-md overflow-hidden">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-panel p-4 h-[86px] animate-pulse" />
          ))}
        </div>
      ) : !position ? (
        <p className="py-8 text-center text-sm text-dim">No position in this asset.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-line rounded-md overflow-hidden">
            <Cell
              label="Total"
              hint="Everything the seller owns. Coupons accrue on this."
              value={total}
              decimals={decimals}
              tone="total"
              annotation={totalHeld ? 'unmoved' : undefined}
              compact={compact}
            />
            <Cell
              label="Available"
              hint="Free to transfer or to offer."
              value={available}
              decimals={decimals}
              tone="available"
              delta={delta?.available}
              compact={compact}
            />
            <Cell
              label="Held"
              hint="Escrowed to SottoSettlement against an open RFQ."
              value={held}
              decimals={decimals}
              tone="held"
              delta={delta?.held}
              compact={compact}
            />
            <Cell
              label="Locked"
              hint="Locked by the issuer — not tradable."
              value={locked}
              decimals={decimals}
              tone="locked"
              compact={compact}
            />
          </div>

          {/* The sentence the animation is making, said once, quietly. */}
          <div
            className={cn(
              'mt-2 text-2xs transition-opacity duration-300',
              totalHeld ? 'opacity-100 text-held' : 'opacity-0 text-transparent'
            )}
            aria-live="polite"
          >
            Available fell and Held rose by the same size. Total did not move — the seller still
            owns the block, and still earns the coupon on all of it.
          </div>

          {cash && (
            <div className="mt-3 pt-3 border-t border-line flex items-center justify-between gap-4">
              <div className="flex items-baseline gap-2">
                <span className="label">Cash</span>
                <span className="text-xs text-muted">{cash.symbol}</span>
              </div>
              <div className="flex items-center gap-5">
                {cash.allowance != null && (
                  <span className="flex items-baseline gap-1.5" title="Approved to SottoSettlement">
                    <span className="label">approved</span>
                    <Num
                      value={cash.allowance}
                      decimals={cash.decimals}
                      kind="cash"
                      className="text-xs text-muted"
                    />
                  </span>
                )}
                <Num
                  value={cash.balance}
                  decimals={cash.decimals}
                  kind="cash"
                  className="text-lg font-medium text-txt"
                />
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

function Cell({
  label, hint, value, decimals, tone, delta, annotation, compact,
}: {
  label: string;
  hint: string;
  value: bigint;
  decimals: number;
  tone: 'total' | 'available' | 'held' | 'locked';
  delta?: bigint;
  annotation?: string;
  compact?: boolean;
}) {
  const valueTone =
    tone === 'total' ? 'text-txt'
    : tone === 'held' ? 'text-held'
    : tone === 'locked' ? 'text-dim'
    : 'text-txt';

  return (
    <div className="bg-panel p-4 relative" title={hint}>
      <div className="flex items-center justify-between gap-2">
        <span className="label">{label}</span>
        {annotation && (
          <span className="text-2xs text-held border border-held/40 rounded px-1 animate-slideIn">
            {annotation}
          </span>
        )}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <Num
          value={value.toString()}
          decimals={decimals}
          kind="qty"
          // Total must never flash — it is the thing that is not changing.
          flash={tone !== 'total'}
          className={cn(compact ? 'text-xl' : 'text-2xl', 'font-medium', valueTone)}
        />
        {delta !== undefined && delta !== 0n && (
          <Delta value={delta.toString()} decimals={decimals} kind="qty" />
        )}
      </div>
      <p className="mt-1 text-2xs text-dim leading-tight hidden sm:block">{hint}</p>
    </div>
  );
}
