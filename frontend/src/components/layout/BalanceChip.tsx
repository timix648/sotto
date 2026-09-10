'use client';

// Balances, always on screen.
//
// You should never have to open a wallet extension to find out what you hold.
// The chip carries the two figures that matter at a glance — the position and
// the cash — and opens into the full breakdown: the four ATS numbers, the cash
// balance, and how much of it is approved to the settlement contract.
//
// It reads GET /api/balances/:account, which returns all four already computed.
// It never calls balanceOf: that returns AVAILABLE, not total, and using it
// here would make a hold look like the holder had lost tokens.
import { useEffect, useRef, useState } from 'react';
import { useBalances } from '@/hooks/useApi';
import { useRole } from '@/hooks/useRole';
import { Addr } from '@/components/ui/Addr';
import { Num } from '@/components/ui/Num';
import { formatCash, formatQty } from '@/lib/format';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';

export function BalanceChip() {
  const { address, isWallet } = useRole();
  const { data, isLoading } = useBalances(address);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  if (!address) return null;

  const position = data?.assets?.[0] ?? null;
  const cash = data?.cash?.[0] ?? null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors focusable',
          open ? 'border-lineBright bg-raised' : 'border-line hover:border-lineBright'
        )}
      >
        {isLoading && !data ? (
          <span className="h-3 w-24 animate-pulse rounded bg-raised" />
        ) : (
          <>
            {position && (
              <span className="num font-medium text-txt">
                {formatQty(position.total, position.decimals)}
                <span className="ml-1 text-dim">{position.symbol}</span>
              </span>
            )}
            {cash && (
              <>
                <span className="text-line" aria-hidden>│</span>
                <span className="num font-medium text-txt">
                  {formatCash(cash.balance, cash.decimals)}
                  <span className="ml-1 text-dim">{cash.symbol}</span>
                </span>
              </>
            )}
          </>
        )}
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={cn('text-dim transition-transform', open && 'rotate-180')}
          aria-hidden
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 animate-slideIn rounded-xl border border-line bg-panel shadow-panel">
          <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
            <div>
              <div className="label">holdings</div>
              <div className="mt-0.5 text-2xs text-dim">
                {isWallet ? 'connected wallet' : 'demo party'}
              </div>
            </div>
            <Addr value={address} href={hashscan.account(address)} />
          </header>

          {position ? (
            <div className="border-b border-line px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-txt">{position.symbol}</span>
                <Num
                  value={position.total}
                  decimals={position.decimals}
                  kind="qty"
                  className="text-lg font-semibold text-txt"
                />
              </div>
              <dl className="mt-2 grid grid-cols-3 gap-2">
                <Cell label="Available" value={formatQty(position.available, position.decimals)} />
                <Cell label="Held" value={formatQty(position.held, position.decimals)} tone="held" />
                <Cell label="Locked" value={formatQty(position.locked, position.decimals)} tone="dim" />
              </dl>
              <p className="mt-2 text-2xs leading-relaxed text-dim">
                Available + Held + Locked is always Total. A hold moves size between them without
                changing what you own.
              </p>
            </div>
          ) : (
            <p className="px-4 py-3 text-xs text-dim">No position in a listed asset.</p>
          )}

          {cash && (
            <div className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-txt">{cash.symbol}</span>
                <Num
                  value={cash.balance}
                  decimals={cash.decimals}
                  kind="cash"
                  className="text-lg font-semibold text-txt"
                />
              </div>
              {cash.allowance != null && (
                <div className="mt-2 flex items-baseline justify-between gap-2">
                  <span className="label">approved to settlement</span>
                  <span className="num text-xs text-muted">
                    {formatCash(cash.allowance, cash.decimals)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Cell({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone?: 'held' | 'dim';
}) {
  return (
    <div className="rounded-lg bg-raised px-2 py-1.5">
      <dt className="label">{label}</dt>
      <dd
        className={cn(
          'num mt-0.5 text-sm font-medium',
          tone === 'held' ? 'text-held' : tone === 'dim' ? 'text-dim' : 'text-txt'
        )}
      >
        {value}
      </dd>
    </div>
  );
}
