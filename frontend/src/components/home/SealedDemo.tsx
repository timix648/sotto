'use client';

// The hero demonstration: one request, cycling sealed → revealed → awarded.
//
// It is a diagram of the mechanism, not a claim about live data — but the
// figures are the real demo values (98.20 · 98.35 · 98.11 · 97.90 against a
// 98.35 mark), so nothing here is invented and nothing contradicts what the
// venue shows once you walk in.
import { useEffect, useState } from 'react';
import { formatPrice } from '@/lib/format';
import { cn } from '@/lib/cn';

const DEALERS = [
  { id: 'A', hash: '0x8d2ae03cd8e7…', price: '98200000' },
  { id: 'B', hash: '0x4c90cf5b62ed…', price: '98350000' },
  { id: 'C', hash: '0x2d87e21e0230…', price: '98110000' },
  { id: 'D', hash: '0xba9a9572f5da…', price: '97900000' },
];

type Phase = 'sealed' | 'revealed' | 'awarded';
const ORDER: Phase[] = ['sealed', 'revealed', 'awarded'];
const DWELL: Record<Phase, number> = { sealed: 3200, revealed: 3000, awarded: 3400 };

export function SealedDemo() {
  const [phase, setPhase] = useState<Phase>('sealed');

  useEffect(() => {
    const next = ORDER[(ORDER.indexOf(phase) + 1) % ORDER.length];
    const t = setTimeout(() => setPhase(next), DWELL[phase]);
    return () => clearTimeout(t);
  }, [phase]);

  const sealed = phase === 'sealed';
  const awarded = phase === 'awarded';

  return (
    <div className="overflow-hidden rounded-xl border-2 border-line bg-panel shadow-panel transition-[transform,border-color,box-shadow] duration-200 ease-out hover:-translate-y-1 hover:border-wine hover:shadow-[0_16px_36px_rgb(112_38_54_/_0.12)]">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <div className="text-xs font-semibold text-txt">250 STO-BOND-A</div>
          <div className="mt-0.5 text-2xs text-dim">one request · four dealers</div>
        </div>
        <span
          className={cn(
            'rounded border px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider transition-colors',
            sealed ? 'border-line text-dim'
              : awarded ? 'border-pos/40 bg-posWash text-pos'
                : 'border-held/40 bg-heldWash text-held'
          )}
        >
          {sealed ? 'Quotes sealed' : awarded ? 'Awarded' : 'Revealed'}
        </span>
      </header>

      <table className="w-full">
        <thead>
          <tr className="border-b border-line">
            <th className="label px-4 py-2 text-left font-semibold">Dealer</th>
            <th className="label px-4 py-2 text-left font-semibold">
              {sealed ? 'Commit hash' : 'Price'}
            </th>
          </tr>
        </thead>
        <tbody>
          {DEALERS.map((d, i) => {
            const isBest = d.id === 'B';
            return (
              <tr
                key={d.id}
                className={cn(
                  'border-b border-line/60 transition-colors last:border-0',
                  awarded && isBest && 'bg-posWash'
                )}
              >
                <td className="px-4 py-2.5">
                  <span className="flex items-center gap-2">
                    <Padlock open={!sealed} tone={awarded && isBest ? 'pos' : 'dim'} />
                    <span className="font-mono text-xs text-muted">Dealer {d.id}</span>
                    {awarded && isBest && (
                      <span className="rounded border border-pos/40 px-1 text-2xs text-pos">
                        won
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  {sealed ? (
                    <span className="font-mono text-2xs text-dim">{d.hash}</span>
                  ) : (
                    <span
                      key={phase}
                      style={{ animationDelay: `${i * 80}ms` }}
                      className={cn(
                        'num inline-block animate-unlock text-sm',
                        awarded && isBest ? 'font-semibold text-pos' : 'text-txt'
                      )}
                    >
                      {formatPrice(d.price, 6)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <footer className="border-t border-line px-4 py-2.5">
        <p className="text-2xs leading-relaxed text-dim">
          {sealed
            ? 'The venue holds hashes, not prices. Nobody can read a quote — including us.'
            : awarded
              ? 'Best valid price wins. Ties break on the earliest consensus sequence number.'
              : 'Each reveal is recomputed against its commit and must match exactly.'}
        </p>
      </footer>
    </div>
  );
}

function Padlock({ open, tone }: { open: boolean; tone: 'pos' | 'dim' }) {
  return (
    <span className={cn('shrink-0', open ? (tone === 'pos' ? 'text-pos' : 'text-muted') : 'text-dim')}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <rect x="4" y="10" width="16" height="11" rx="2" />
        {open ? <path d="M8 10V7a4 4 0 0 1 7.5-2" /> : <path d="M8 10V7a4 4 0 0 1 8 0v3" />}
      </svg>
    </span>
  );
}
