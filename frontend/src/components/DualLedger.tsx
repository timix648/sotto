'use client';

// B4/B5 — the two ledgers, side by side.
//
// START-HERE §6: "seller and buyer side by side, both updating in the same
// instant on settlement. The simultaneity IS the product."
//
// And B5, which matters more: when settlement reverts, both ledgers are
// annotated "unchanged" with the pre- and post- numbers next to each other.
// "Do not hide the failure path — it is the strongest thing in the demo."
//
// MECHANICS §4.10 has the warning that shapes the code: a successful settlement
// was once displayed as a failure because the success check read an undefined
// field. So this component is told the outcome explicitly by its parent. It
// never infers one from whether some number looks different.
import { Panel } from '@/components/ui/Panel';
import { Addr } from '@/components/ui/Addr';
import { Num } from '@/components/ui/Num';
import { formatCash, formatQty } from '@/lib/format';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';

export interface LedgerSide {
  label: string;
  address: string | null | undefined;
  assetSymbol: string;
  assetDecimals: number;
  asset: string | null | undefined;   // total position, base units
  cashSymbol: string;
  cashDecimals: number;
  cash: string | null | undefined;
}

export type LedgerOutcome = 'pending' | 'settled' | 'reverted';

export interface LedgerSnapshot {
  seller: { asset: string; cash: string };
  buyer: { asset: string; cash: string };
}

/** The trade that was attempted, so a revert can show what did NOT happen. */
export interface AttemptedTrade {
  quantity: string;
  notional: string;
}

const big = (v: string | null | undefined): bigint | null => {
  if (v === null || v === undefined || v === '') return null;
  try { return BigInt(String(v)); } catch { return null; }
};

/**
 * What each figure WOULD have become had the settlement gone through.
 *
 * B5 asks for the pre- and post- numbers side by side. A live snapshot only
 * exists if this page happened to be open when settlement was attempted — and
 * the person who most needs to see this (a judge opening the link afterwards)
 * never is. So the counterfactual is derived from the trade instead: the legs
 * are known exactly, which makes "unchanged" a checkable claim rather than an
 * assertion the UI makes about itself.
 */
function wouldHaveBeen(
  current: string | null | undefined,
  delta: bigint
): string | null {
  const c = big(current);
  return c === null ? null : (c + delta).toString();
}

export function DualLedger({
  seller, buyer, outcome, snapshot, attempted,
}: {
  seller: LedgerSide;
  buyer: LedgerSide;
  outcome: LedgerOutcome;
  /** Balances as they stood before settlement was attempted, when observed live. */
  snapshot?: LedgerSnapshot | null;
  attempted?: AttemptedTrade | null;
}) {
  const reverted = outcome === 'reverted';

  const qty = big(attempted?.quantity) ?? 0n;
  const notional = big(attempted?.notional) ?? 0n;

  // On a revert, "before" is the same as now — nothing moved. What is worth
  // showing is the value the other outcome would have produced.
  const counterfactual = reverted && attempted
    ? {
        seller: {
          asset: wouldHaveBeen(seller.asset, -qty),
          cash: wouldHaveBeen(seller.cash, notional),
        },
        buyer: {
          asset: wouldHaveBeen(buyer.asset, qty),
          cash: wouldHaveBeen(buyer.cash, -notional),
        },
      }
    : null;

  return (
    <div className="space-y-2">
      <div className="grid gap-3 md:grid-cols-2">
        <Side
          side={seller}
          outcome={outcome}
          before={snapshot?.seller}
          wouldBe={counterfactual?.seller}
          role="seller"
        />
        <Side
          side={buyer}
          outcome={outcome}
          before={snapshot?.buyer}
          wouldBe={counterfactual?.buyer}
          role="buyer"
        />
      </div>

      {reverted && (
        <p className="text-xs text-neg text-center px-4 py-2 border border-neg/30 bg-neg/[0.06] rounded-md">
          Neither ledger moved. Both legs, or neither — the reason is below.
        </p>
      )}
      {outcome === 'settled' && (
        <p className="text-xs text-pos text-center px-4 py-2 border border-pos/30 bg-pos/[0.06] rounded-md">
          Both ledgers moved in the same transaction. Cash to the seller, the block to the buyer —
          both, or neither.
        </p>
      )}
    </div>
  );
}

function Side({
  side, outcome, before, wouldBe, role,
}: {
  side: LedgerSide;
  outcome: LedgerOutcome;
  before?: { asset: string; cash: string };
  wouldBe?: { asset: string | null; cash: string | null } | null;
  role: 'seller' | 'buyer';
}) {
  const reverted = outcome === 'reverted';
  const settled = outcome === 'settled';

  return (
    <Panel
      tone={reverted ? 'danger' : settled ? 'success' : 'default'}
      className={cn('transition-colors duration-500')}
      title={
        <span className="flex items-center gap-2">
          <span>{side.label}</span>
          <span className="label">{role}</span>
        </span>
      }
      right={<Addr value={side.address} href={hashscan.account(side.address)} />}
      bodyClassName="p-0"
    >
      <Row
        label={side.assetSymbol}
        hint="security leg"
        value={side.asset}
        before={before?.asset}
        wouldBe={wouldBe?.asset}
        decimals={side.assetDecimals}
        kind="qty"
        reverted={reverted}
      />
      <Row
        label={side.cashSymbol}
        hint="cash leg"
        value={side.cash}
        before={before?.cash}
        wouldBe={wouldBe?.cash}
        decimals={side.cashDecimals}
        kind="cash"
        reverted={reverted}
        last
      />
    </Panel>
  );
}

function Row({
  label, hint, value, before, wouldBe, decimals, kind, reverted, last,
}: {
  label: string;
  hint: string;
  value: string | null | undefined;
  before?: string;
  wouldBe?: string | null;
  decimals: number;
  kind: 'qty' | 'cash';
  reverted: boolean;
  last?: boolean;
}) {
  const fmt = kind === 'cash' ? formatCash : formatQty;
  // Prefer a genuinely observed pre-settlement figure; fall back to the fact
  // that a reverted trade cannot have changed anything.
  const beforeShown = before ?? (reverted ? (value ?? undefined) : undefined);
  const unchanged =
    reverted && beforeShown !== undefined && String(beforeShown) === String(value ?? '');

  return (
    <div className={cn('px-4 py-3 flex items-start justify-between gap-4', !last && 'border-b border-line')}>
      <div className="min-w-0">
        <div className="text-sm text-txt">{label}</div>
        <div className="label">{hint}</div>
      </div>

      {reverted && beforeShown !== undefined ? (
        // B5 — the pre- and post- numbers side by side, explicitly annotated,
        // and the figure the settlement would have produced had it gone through.
        <div className="text-right">
          <div className="flex items-center justify-end gap-3">
            <div>
              <div className="label">before</div>
              <div className="num text-sm text-muted">{fmt(beforeShown, decimals)}</div>
            </div>
            <span className="text-dim" aria-hidden>→</span>
            <div>
              <div className="label">after</div>
              <div className="num text-sm text-txt">{fmt(value, decimals)}</div>
            </div>
            {unchanged && (
              <span className="text-2xs text-neg border border-neg/40 rounded px-1.5 py-0.5">
                unchanged
              </span>
            )}
          </div>
          {wouldBe != null && (
            <div className="mt-1 text-2xs text-dim">
              would have been{' '}
              <span className="num line-through decoration-neg/60">{fmt(wouldBe, decimals)}</span>
            </div>
          )}
        </div>
      ) : (
        <Num
          value={value}
          decimals={decimals}
          kind={kind}
          className="text-xl font-medium text-txt"
        />
      )}
    </div>
  );
}
