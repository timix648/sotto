'use client';

// A number, rendered once, correctly, everywhere.
//
// The tween exists for B2: "available drops, held rises, total is unmoved" has
// to be legible without narration, and a value that snaps gives the eye nothing
// to follow. Two safeguards keep it honest:
//   - it never animates on first paint, so a real balance never appears to
//     count up from zero;
//   - it always lands on the exact value — the tween interpolates in base units
//     with bigint maths and finishes on the true figure, never near it.
import { useEffect, useRef, useState } from 'react';
import { formatCash, formatPrice, formatQty } from '@/lib/format';
import { cn } from '@/lib/cn';

type Kind = 'cash' | 'qty' | 'price';

const render = (v: bigint, kind: Kind, decimals: number) =>
  kind === 'cash' ? formatCash(v, decimals)
  : kind === 'price' ? formatPrice(v, decimals)
  : formatQty(v, decimals);

const toBig = (v: string | bigint | null | undefined): bigint | null => {
  if (v === null || v === undefined || v === '') return null;
  try { return typeof v === 'bigint' ? v : BigInt(String(v)); } catch { return null; }
};

const DURATION = 520;

export function Num({
  value, decimals, kind = 'qty', animate = true, className, flash = true,
}: {
  value: string | bigint | null | undefined;
  decimals: number;
  kind?: Kind;
  animate?: boolean;
  flash?: boolean;
  className?: string;
}) {
  const target = toBig(value);
  const [shown, setShown] = useState<bigint | null>(target);
  const [dir, setDir] = useState<'up' | 'down' | null>(null);
  const prev = useRef<bigint | null>(target);
  const first = useRef(true);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (target === null) { setShown(null); return; }

    // First paint: show the truth immediately, never tween up from nothing.
    if (first.current) {
      first.current = false;
      prev.current = target;
      setShown(target);
      return;
    }
    if (prev.current === target) return;

    const from = prev.current ?? target;
    const delta = target - from;
    setDir(delta > 0n ? 'up' : 'down');

    if (!animate) {
      prev.current = target;
      setShown(target);
      return;
    }

    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / DURATION);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p >= 1) {
        prev.current = target;
        setShown(target);            // land exactly
        raf.current = null;
        return;
      }
      const scaled = BigInt(Math.round(eased * 10000));
      setShown(from + (delta * scaled) / 10000n);
      raf.current = requestAnimationFrame(step);
    };
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(step);

    const clear = setTimeout(() => setDir(null), 950);
    return () => {
      clearTimeout(clear);
      if (raf.current) { cancelAnimationFrame(raf.current); raf.current = null; }
    };
  }, [target, animate]);

  if (shown === null) return <span className={cn('num text-dim', className)}>—</span>;

  return (
    <span
      className={cn(
        'num tabular-nums rounded px-0.5 -mx-0.5',
        flash && dir === 'up' && 'animate-flashPos',
        flash && dir === 'down' && 'animate-flashNeg',
        className
      )}
    >
      {render(shown, kind, decimals)}
    </span>
  );
}

/** A small ±delta chip, shown beside a figure that just moved. */
export function Delta({
  value, decimals, kind = 'qty', className,
}: {
  value: string | bigint | null | undefined;
  decimals: number;
  kind?: Kind;
  className?: string;
}) {
  const v = toBig(value);
  if (v === null || v === 0n) return null;
  const positive = v > 0n;
  return (
    <span
      className={cn(
        'num text-2xs font-mono px-1 py-px rounded',
        positive ? 'text-pos bg-pos/10' : 'text-neg bg-neg/10',
        className
      )}
    >
      {positive ? '+' : '−'}
      {render(v < 0n ? -v : v, kind, decimals)}
    </span>
  );
}
