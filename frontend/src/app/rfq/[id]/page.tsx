'use client';

// B4 the settlement theatre, and B5 the failure view — one screen, because they
// are the same screen with a different outcome. "Do not hide the failure path —
// it is the strongest thing in the demo."
//
// The dual ledger sits above the timeline so that both ledgers are in one glance
// at the moment of settlement. Both change, or neither does.
import { use, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Panel } from '@/components/ui/Panel';
import { Addr, HashScanLink } from '@/components/ui/Addr';
import { StatusPill, Countdown } from '@/components/ui/Status';
import { Callout } from '@/components/ui/Field';
import { DualLedger, type LedgerSnapshot, type LedgerOutcome } from '@/components/DualLedger';
import { SettlementSwap } from '@/components/SettlementSwap';
import { Shell } from '@/components/layout/Shell';
import { AuditTimeline } from '@/components/AuditTimeline';
import { QuoteBoard } from '@/components/QuoteBoard';
import { useHealth, useRfq, useBalances, useAssets, useRfqSubscription } from '@/hooks/useApi';
import { ERROR_COPY } from '@/lib/api';
import { hashscan } from '@/lib/hashscan';
import { formatQty, formatCash, formatPrice, formatClock, computeNotional } from '@/lib/format';

export default function RfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: detail, isLoading, isError } = useRfq(id);
  const { data: health } = useHealth();
  const { data: assets } = useAssets();

  useRfqSubscription(id);

  const rfq = detail?.rfq;
  const award = detail?.award ?? null;
  const settlement = detail?.settlement ?? null;

  const seller = rfq?.seller ?? null;
  const buyer = award?.dealer ?? null;

  const { data: sellerBal } = useBalances(seller);
  const { data: buyerBal } = useBalances(buyer);

  const cashDecimals = health?.cashDecimals ?? 6;
  const asset = assets?.find((a) => a.token === rfq?.assetToken);
  const assetDecimals = asset?.decimals ?? 0;

  // The outcome is read from the record, never inferred from a balance looking
  // different — MECHANICS §4.10: "a successful settlement displayed as a failure,
  // because the success check read a field that was undefined."
  // PARTIALLY_SETTLED counts as settled here: cash and securities did move, and
  // this drives the ledger panel, which is about whether balances changed. Which
  // individual fill failed is shown on that fill, below.
  const outcome: LedgerOutcome =
    settlement?.status === 'SETTLED'
    || rfq?.status === 'SETTLED'
    || rfq?.status === 'PARTIALLY_SETTLED'
      ? 'settled'
      : settlement?.status === 'REVERTED' || rfq?.status === 'FAILED'
        ? 'reverted'
        : 'pending';

  /**
   * Each fill, paired with the transaction that settled it.
   *
   * Partial settlements always carried their nonce in the audit; the final one
   * - the transaction that completes the block - did not, so a two-dealer fill
   * had one transaction it could attribute and one it could only guess at. The
   * venue names it now, and anything older falls back to the settlement's own
   * hash so historical requests still link somewhere true.
   */
  const swaps = useMemo(() => {
    const fills = detail?.fills ?? [];
    if (fills.length < 1) return [];
    const settledNonces = new Set(detail?.settledFillNonces ?? []);
    // Once the request stops trading, a fill that has not settled never will.
    const terminal = ['SETTLED', 'PARTIALLY_SETTLED', 'FAILED', 'EXPIRED']
      .includes(detail?.rfq?.status ?? '');
    const events = (detail?.audit ?? []).filter((e) => e.kind === 'SETTLED');

    return fills.map((f) => {
      const t = f.trade;
      const ev = events.find(
        (e) => (e.payload as { nonce?: string } | undefined)?.nonce === t.nonce
      );
      const settled = settledNonces.has(t.nonce);
      return {
        nonce: t.nonce,
        buyer: t.buyer,
        quantity: t.quantity,
        notional: t.notional,
        price: f.price,
        // A fill's fate is its own. Judging it by the request's overall status
        // hid the failed half of a partial settlement behind an overall
        // "settled", and vice versa.
        outcome: (settled
          ? 'settled'
          : terminal ? 'reverted' : 'pending') as LedgerOutcome,
        txHash:
          ((ev?.payload as { txHash?: string } | undefined)?.txHash)
          ?? (fills.length === 1 ? settlement?.txHash ?? null : null),
        hcsSequence: ev?.hcsSequenceNumber ?? null,
      };
    });
  }, [detail?.fills, detail?.settledFillNonces, detail?.audit, detail?.rfq?.status, settlement?.txHash]);

  // Balances as they stood before settlement was attempted, so B5 can show
  // "before → after, unchanged" rather than asserting it.
  const snapshot = useRef<LedgerSnapshot | null>(null);
  useEffect(() => {
    if (outcome !== 'pending') return;
    if (!sellerBal?.assets?.[0] || !buyerBal?.assets?.[0]) return;
    snapshot.current = {
      seller: {
        asset: sellerBal.assets[0].total,
        cash: sellerBal.cash?.[0]?.balance ?? '0',
      },
      buyer: {
        asset: buyerBal.assets[0].total,
        cash: buyerBal.cash?.[0]?.balance ?? '0',
      },
    };
  }, [outcome, sellerBal, buyerBal]);

  const reason = settlement?.reason ?? null;
  const reasonCopy = reason ? (ERROR_COPY[reason] ?? reason) : null;

  if (isError) {
    return (
      <Callout tone="neg" title="That request could not be loaded">
        The venue API returned no RFQ for <span className="font-mono">{id}</span>.{' '}
        <Link href="/" className="underline">Back to the venue</Link>.
      </Callout>
    );
  }

  if (isLoading || !rfq) {
    return <div className="h-64 rounded-lg bg-panel animate-pulse" />;
  }

  return (
    <Shell className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-base font-medium text-txt">
              {formatQty(rfq.quantity, assetDecimals)} {rfq.assetSymbol}
            </h1>
            <StatusPill status={rfq.status} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-dim">
            <span className="flex items-center gap-1.5">
              <span className="label">request</span>
              <Addr value={rfq.id} />
            </span>
            <span className="flex items-center gap-1.5">
              <span className="label">asset</span>
              <Addr value={rfq.assetToken} href={hashscan.contract(rfq.assetToken)} />
            </span>
            {rfq.holdId != null && <span>hold #{rfq.holdId}</span>}
          </div>
        </div>

        <div className="text-right">
          {rfq.status === 'OPEN' && <Countdown deadline={rfq.commitDeadline} label="window closes" />}
          {rfq.status === 'REVEALING' && <Countdown deadline={rfq.revealDeadline} label="reveal ends" />}
          {award && (
            <div className="mt-1">
              <div className="label">awarded at</div>
              <div className="num text-lg text-txt">{formatPrice(award.price, cashDecimals)}</div>
            </div>
          )}
        </div>
      </div>

      {/*
        One swap per fill. A block filled across two dealers was rendering as a
        single trade - the header said 9 units, the swap underneath said 5, and
        the dealer who took the other 4 did not appear anywhere. Each fill is
        its own Trade, its own signatures and its own transaction; showing one
        of them and calling it the settlement misrepresents the feature the
        venue exists for.
      */}
      {swaps.length ? (
        swaps.map((s, i) => (
          <div key={s.nonce ?? i} className="space-y-2">
            {swaps.length > 1 && (
              <div className="flex items-baseline justify-between px-1 text-2xs text-dim">
                <span className="label">Fill {i + 1} of {swaps.length}</span>
                <span className="num">
                  {formatQty(s.quantity, assetDecimals)} {rfq.assetSymbol} @{' '}
                  {formatPrice(s.price, cashDecimals)}
                </span>
              </div>
            )}
            <SettlementSwap
              outcome={s.outcome}
              seller={seller}
              buyer={s.buyer}
              quantity={s.quantity}
              assetSymbol={rfq.assetSymbol}
              assetDecimals={assetDecimals}
              notional={s.notional}
              cashSymbol={sellerBal?.cash?.[0]?.symbol ?? 'USDC'}
              cashDecimals={cashDecimals}
              txHash={s.txHash}
              hcsSequence={s.hcsSequence}
              path={settlement?.path ?? null}
            />
          </div>
        ))
      ) : (
        <SettlementSwap
          outcome={outcome}
          seller={seller}
          buyer={buyer}
          quantity={award?.quantity ?? rfq.quantity}
          assetSymbol={rfq.assetSymbol}
          assetDecimals={assetDecimals}
          notional={
            award ? (award.notional ?? computeNotional(award.price, rfq.quantity)) : null
          }
          cashSymbol={sellerBal?.cash?.[0]?.symbol ?? 'USDC'}
          cashDecimals={cashDecimals}
          txHash={settlement?.txHash ?? null}
          hcsSequence={
            detail?.audit?.find((e) => e.kind === 'SETTLED' || e.kind === 'SETTLEMENT_REVERTED')
              ?.hcsSequenceNumber ?? null
          }
          path={settlement?.path ?? null}
        />
      )}

      {/* B4 — both ledgers, side by side, in one glance. */}
      <DualLedger
        outcome={outcome}
        snapshot={outcome === 'pending' ? null : snapshot.current}
        attempted={
          award
            ? {
                quantity: award.quantity ?? rfq.quantity,
                notional: award.notional ?? computeNotional(award.price, rfq.quantity),
              }
            : null
        }
        seller={{
          label: 'Seller',
          address: seller,
          assetSymbol: rfq.assetSymbol,
          assetDecimals,
          asset: sellerBal?.assets?.[0]?.total,
          cashSymbol: sellerBal?.cash?.[0]?.symbol ?? 'USDC',
          cashDecimals,
          cash: sellerBal?.cash?.[0]?.balance,
        }}
        buyer={{
          label: buyer ? 'Buyer' : 'Buyer — not awarded yet',
          address: buyer,
          assetSymbol: rfq.assetSymbol,
          assetDecimals,
          asset: buyerBal?.assets?.[0]?.total,
          cashSymbol: buyerBal?.cash?.[0]?.symbol ?? 'USDC',
          cashDecimals,
          cash: buyerBal?.cash?.[0]?.balance,
        }}
      />

      {/*
        The title used to be the reason, and the body always explained a
        compliance refusal. Most reverts are not that: a lapsed firmness
        deadline never reaches the delivery call at all, so the page was
        confidently naming the wrong cause under a wall of logsBloom. The venue
        decodes the custom error now and sends one sentence; this just shows it,
        and says the atomicity part without claiming to know which guard fired.
      */}
      {outcome === 'reverted' && (
        <Callout tone="neg" title="Settlement reverted — nothing moved">
          {reasonCopy ?? 'The settlement transaction reverted.'}{' '}
          Both legs live in one transaction, so a failure at any point returns the cash and
          leaves the security in escrow. That is the difference between a settlement system and
          a token transfer.
        </Callout>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3 space-y-4">
          <Panel
            title="Lifecycle"
            subtitle="Every stage, timestamped on the Hedera Consensus Service"
            right={
              health?.topicId ? (
                <HashScanLink href={hashscan.topic(health.topicId)}>
                  topic {health.topicId}
                </HashScanLink>
              ) : null
            }
          >
            <AuditTimeline
              events={detail?.audit ?? []}
              cashDecimals={cashDecimals}
              assetDecimals={assetDecimals}
              assetSymbol={rfq.assetSymbol}
            />
          </Panel>
        </div>

        <div className="lg:col-span-2 space-y-4">
          <Panel title="Settlement">
            <dl className="space-y-3 text-xs">
              <Row label="Outcome">
                <span
                  className={
                    outcome === 'settled' ? 'text-pos' : outcome === 'reverted' ? 'text-neg' : 'text-muted'
                  }
                >
                  {outcome === 'settled' ? 'Settled atomically' : outcome === 'reverted' ? 'Reverted' : 'Not yet settled'}
                </span>
              </Row>
              {settlement?.path && (
                <Row label="Path">
                  {settlement.path === 'A'
                    ? 'A — EVM allowance, permissionless'
                    : 'B — HIP-551 atomic batch'}
                </Row>
              )}
              {award && (
                <>
                  <Row label="Buyer"><Addr value={award.dealer} href={hashscan.account(award.dealer)} /></Row>
                  <Row label="Price"><span className="num text-txt">{formatPrice(award.price, cashDecimals)}</span></Row>
                  <Row label="Notional"><span className="num text-txt">{formatCash(award.notional, cashDecimals)}</span></Row>
                </>
              )}
              {settlement?.txHash && (
                <Row label="Transaction">
                  <Addr value={settlement.txHash} kind="hash" href={hashscan.tx(settlement.txHash)} />
                </Row>
              )}
              <Row label="Opened">
                <span className="font-mono text-2xs text-muted">{formatClock(rfq.createdAt)}</span>
              </Row>
            </dl>
          </Panel>

          <Panel title="Verify it yourself" subtitle="The claims, and where each one is checked">
            <ul className="space-y-2 text-xs leading-relaxed text-muted">
              <li>
                Commit hashes carry sequence numbers strictly below the reveals above them —
                every price was timestamped before it was readable.
              </li>
              <li>
                The window closed on a consensus timestamp, not on our clock.
              </li>
              <li>
                Compliance ran inside the transfer, in ATS, not in venue code.
              </li>
            </ul>
            <Link
              href="/rulebook"
              className="mt-3 inline-block text-xs text-txt underline underline-offset-2 decoration-line hover:decoration-current focusable rounded"
            >
              Read the rulebook →
            </Link>
          </Panel>
        </div>
      </div>

      <QuoteBoard
        rfq={rfq}
        commits={detail?.commits ?? []}
        reveals={detail?.reveals ?? []}
        cashDecimals={cashDecimals}
        nav={asset?.nav ?? null}
        awardedDealer={award?.dealer ?? null}
      />
    </Shell>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="label">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
