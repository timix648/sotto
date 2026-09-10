'use client';

// The swap itself, drawn.
//
// Two lanes running in opposite directions at the same time: the security leg
// from seller to buyer, the cash leg from buyer to seller. They are one
// transaction, so they animate as one — there is no frame in which the buyer
// holds the security and the seller has not been paid.
//
// On a revert the flow sets off and is pulled back. That is the honest picture
// of what the EVM does: the transfer runs, the compliance check on delivery
// refuses, and the whole transaction unwinds.
//
// The direction of travel is drawn with a flowing dashed gradient rather than a
// chip animated across a measured distance — it needs no layout measurement, so
// it cannot desynchronise between the two lanes at any width.
import { Num } from '@/components/ui/Num';
import { Addr, HashScanLink } from '@/components/ui/Addr';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';

export type SwapOutcome = 'pending' | 'settled' | 'reverted';

export function SettlementSwap({
  outcome, seller, buyer, quantity, assetSymbol, assetDecimals,
  notional, cashSymbol, cashDecimals, txHash, hcsSequence, path,
}: {
  outcome: SwapOutcome;
  seller: string | null | undefined;
  buyer: string | null | undefined;
  quantity: string | null | undefined;
  assetSymbol: string;
  assetDecimals: number;
  notional: string | null | undefined;
  cashSymbol: string;
  cashDecimals: number;
  txHash?: string | null;
  hcsSequence?: number | null;
  path?: 'A' | 'B' | null;
}) {
  const settled = outcome === 'settled';
  const reverted = outcome === 'reverted';

  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl border-2 bg-panel transition-transform duration-200 ease-out hover:-translate-y-0.5',
        settled ? 'border-pos/40' : reverted ? 'border-neg/40' : 'border-line'
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-txt">
            {settled ? 'Settled atomically' : reverted ? 'Reverted — nothing moved' : 'Awaiting settlement'}
          </h2>
          <p className="mt-0.5 text-2xs text-dim">
            {settled
              ? 'Both legs moved in one indivisible transaction'
              : reverted
                ? 'Both legs were rolled back together'
                : 'Both legs will move together, or neither will'}
          </p>
        </div>
        <span
          className={cn(
            'rounded border px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider',
            settled ? 'border-pos/40 bg-posWash text-pos'
              : reverted ? 'border-neg/40 bg-negWash text-neg'
                : 'border-line text-dim'
          )}
        >
          {settled ? 'Settled' : reverted ? 'Reverted' : 'Pending'}
        </span>
      </header>

      <div className="px-4 py-5 sm:px-6">
        <div className="mb-3 flex items-center justify-between gap-4 text-2xs">
          <span className="flex items-center gap-1.5">
            <span className="label">seller</span>
            <Addr value={seller} href={hashscan.account(seller)} />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="label">buyer</span>
            <Addr value={buyer} href={hashscan.account(buyer)} />
          </span>
        </div>

        <Lane
          direction="right"
          outcome={outcome}
          label="Security leg"
          sublabel="delivery — ATS runs compliance here"
          value={
            <Num value={quantity} decimals={assetDecimals} kind="qty" className="text-base font-semibold" />
          }
          unit={assetSymbol}
        />

        <div className="relative my-1 flex items-center justify-center">
          <span
            className={cn(
              'rounded-full border px-3 py-1 text-2xs font-semibold uppercase tracking-[0.12em]',
              settled ? 'border-pos/40 bg-posWash text-pos'
                : reverted ? 'border-neg/40 bg-negWash text-neg'
                  : 'border-line bg-raised text-dim'
            )}
          >
            One transaction
          </span>
        </div>

        <Lane
          direction="left"
          outcome={outcome}
          label="Cash leg"
          sublabel="payment — real Circle USDC"
          value={
            <Num value={notional} decimals={cashDecimals} kind="cash" className="text-base font-semibold" />
          }
          unit={cashSymbol}
        />

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-2xs">
          <p className={cn('max-w-lg leading-relaxed', reverted ? 'text-neg' : 'text-muted')}>
            {settled
              ? 'There is no window in which the buyer holds the security and the seller has not been paid. The hold released straight to the awarded address and the cash moved in the same call.'
              : reverted
                ? 'The delivery was refused, so the payment that ran a line earlier was rolled back with it. This is the difference between a settlement system and a token transfer.'
                : 'The cash leg and the security leg are the same transaction. Any failure reverts both.'}
          </p>
          <span className="flex shrink-0 items-center gap-3">
            {path && (
              <span className="text-dim">
                Path {path} · {path === 'A' ? 'EVM allowance' : 'HIP-551 batch'}
              </span>
            )}
            {hcsSequence != null && <span className="font-mono text-dim">HCS #{hcsSequence}</span>}
            {txHash && <HashScanLink href={hashscan.tx(txHash)}>transaction</HashScanLink>}
          </span>
        </div>
      </div>
    </section>
  );
}

function Lane({
  direction, outcome, label, sublabel, value, unit,
}: {
  direction: 'left' | 'right';
  outcome: SwapOutcome;
  label: string;
  sublabel: string;
  value: React.ReactNode;
  unit: string;
}) {
  const settled = outcome === 'settled';
  const reverted = outcome === 'reverted';

  const hue = settled ? 'text-pos' : reverted ? 'text-neg' : 'text-muted';
  const wash = settled ? 'bg-posWash' : reverted ? 'bg-negWash' : 'bg-raised';
  const border = settled ? 'border-pos/30' : reverted ? 'border-neg/30' : 'border-line';

  // The cash lane is mirrored so the two legs visibly oppose each other. A
  // paused frame of the video has to read as "these went opposite ways" without
  // the flow animation doing the work — both destinations on the right made the
  // still frame say nothing.
  const mirrored = direction === 'left';

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border px-3 py-3 sm:gap-5 sm:px-4',
        mirrored && 'flex-row-reverse',
        border,
        wash
      )}
    >
      <div className={cn('w-[7.5rem] shrink-0 sm:w-40', mirrored && 'text-right')}>
        <div className="label">{label}</div>
        <div className="mt-0.5 hidden text-2xs leading-tight text-dim sm:block">{sublabel}</div>
      </div>

      <div className="relative flex min-w-0 flex-1 items-center">
        <Flow direction={direction} outcome={outcome} />
        <span
          className={cn(
            'relative z-10 mx-auto flex items-baseline gap-1.5 rounded-lg border bg-panel px-2.5 py-1 sm:px-3',
            border,
            hue,
            settled && 'animate-settleLand'
          )}
        >
          {value}
          <span className="text-2xs font-medium text-dim">{unit}</span>
        </span>
        {/* Arrowhead at the end the leg is travelling towards. */}
        <span
          aria-hidden
          className={cn('absolute top-1/2 -translate-y-1/2', hue, mirrored ? 'left-0' : 'right-0')}
        >
          <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor">
            {mirrored ? <path d="M8 0 L2 5 L8 10 Z" /> : <path d="M2 0 L8 5 L2 10 Z" />}
          </svg>
        </span>
      </div>

      <div
        className={cn(
          'w-16 shrink-0 text-2xs font-medium sm:w-24',
          mirrored ? 'text-left' : 'text-right',
          hue
        )}
      >
        {reverted ? 'returned' : direction === 'right' ? 'to buyer' : 'to seller'}
      </div>
    </div>
  );
}

/**
 * A dashed stripe flowing along the lane. Animated via background-position, so
 * there is nothing to measure and both lanes stay in lockstep at any width.
 */
function Flow({ direction, outcome }: { direction: 'left' | 'right'; outcome: SwapOutcome }) {
  const reverted = outcome === 'reverted';
  const colour = outcome === 'settled'
    ? 'rgb(var(--pos))'
    : reverted
      ? 'rgb(var(--neg))'
      : 'rgb(var(--dim))';

  return (
    <span
      aria-hidden
      className={cn(
        'absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2',
        reverted ? 'sotto-flow-recoil' : direction === 'right' ? 'sotto-flow-right' : 'sotto-flow-left'
      )}
      style={{
        backgroundImage: `repeating-linear-gradient(to right, ${colour} 0 6px, transparent 6px 14px)`,
        backgroundSize: '14px 1px',
        opacity: 0.55,
      }}
    />
  );
}
