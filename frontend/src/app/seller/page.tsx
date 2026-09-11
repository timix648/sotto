'use client';

// B2 — the seller portal.
//
// The order of this page is the order of the story: the position first (the
// four numbers), then the offer that moves two of them, then the sealed board
// the offer produces. A viewer should be able to follow it without narration.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Panel, Empty } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Callout } from '@/components/ui/Field';
import { Addr } from '@/components/ui/Addr';
import { StatusPill } from '@/components/ui/Status';
import { PageHead } from '@/components/layout/PageHead';
import { Shell } from '@/components/layout/Shell';
import { BalanceCard } from '@/components/BalanceCard';
import { QuoteBoard } from '@/components/QuoteBoard';
import { RfqList } from '@/components/RfqList';
import { useHealth, useAssets, useBalances, useRfqs, useRfq, useRfqSubscription, useNow, qk } from '@/hooks/useApi';
import { useRole } from '@/hooks/useRole';
import { api, errorCopy } from '@/lib/api';
import { useSignTrade } from '@/lib/sign';
import { holdAbi, releaseHoldAbi, DEFAULT_HOLD_SECONDS } from '@/lib/ats';
import { formatQty, formatPrice, parseAmount } from '@/lib/format';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWriteContract } from 'wagmi';
import { getAddress, zeroAddress, type Hex } from 'viem';
import type { Rfq } from '@sotto/shared';

export default function SellerPage() {
  const { address, isWallet } = useRole();
  const { data: health } = useHealth();
  const { data: assets } = useAssets();
  const { data: balances, isLoading: balancesLoading } = useBalances(address);
  const { data: rfqs } = useRfqs();
  const qc = useQueryClient();

  const mine = useMemo(
    () => (rfqs ?? []).filter((r) => address && r.seller.toLowerCase() === address.toLowerCase()),
    [rfqs, address]
  );
  const active = mine.find((r) => ['OPEN', 'REVEALING', 'AWARDED'].includes(r.status)) ?? null;
  const past = mine.filter((r) => !active || r.id !== active.id);

  const position = balances?.assets?.[0] ?? null;
  const cash = balances?.cash?.[0] ?? null;

  return (
    <Shell className="space-y-6">
      <PageHead
        title="Seller"
        blurb="Escrow a block, collect sealed quotes, allocate the book and settle both legs atomically."
        address={address}
        isWallet={isWallet}
      />

      <BalanceCard
        position={position}
        cash={cash}
        loading={balancesLoading}
        title="Position"
        subtitle="A hold moves size from Available to Held. Total does not move, and coupons keep accruing on all of it."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          {active ? (
            <ActiveOffer rfq={active} cashDecimals={health?.cashDecimals ?? 6} />
          ) : (
            <OfferForm
              assets={assets}
              available={position?.available ?? '0'}
              assetDecimals={position?.decimals ?? 0}
              seller={address}
              cashToken={health?.cashToken ?? null}
              settlementAddress={health?.settlementAddress ?? null}
              isWallet={isWallet}
              onCreated={() => {
                qc.invalidateQueries({ queryKey: ['rfqs'] });
                qc.invalidateQueries({ queryKey: ['balances'] });
              }}
            />
          )}

        </div>

        <div className="space-y-4">
          <RfqList
            rfqs={rfqs && past}
            title="Your requests"
            subtitle="Everything you have put up for bid"
            emptyMessage="You have not offered a block yet."
            assetDecimals={position?.decimals ?? 0}
            dense
          />
        </div>
      </div>
    </Shell>
  );
}

// ------------------------------------------------------------------ the offer

function OfferForm({
  assets, available, assetDecimals, seller, cashToken, settlementAddress, isWallet, onCreated,
}: {
  assets: ReturnType<typeof useAssets>['data'];
  available: string;
  assetDecimals: number;
  seller: string | null;
  cashToken: string | null;
  settlementAddress: string | null;
  isWallet: boolean;
  onCreated: () => void;
}) {
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [assetToken, setAssetToken] = useState('');
  const [qty, setQty] = useState('250');
  const [commitWindow, setCommitWindow] = useState('120');
  const [revealWindow, setRevealWindow] = useState('60');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);

  const chosen = assets?.find((a) => a.token === assetToken) ?? assets?.[0] ?? null;
  const partition = chosen?.partition ?? null;

  const qtyError = (() => {
    if (!qty.trim()) return null;
    try {
      const base = BigInt(parseAmount(qty, assetDecimals));
      if (base <= 0n) return 'Offer at least one unit.';
      if (base > BigInt(available || '0')) {
        return `Only ${formatQty(available, assetDecimals)} available.`;
      }
      return null;
    } catch {
      return 'Enter a number.';
    }
  })();

  const canSubmit =
    Boolean(isWallet && seller && chosen && partition && cashToken && settlementAddress && publicClient) &&
    !qtyError && !busy && qty.trim() !== '';

  async function submit() {
    if (!chosen || !partition || !cashToken || !seller || !settlementAddress || !publicClient) return;
    setBusy(true);
    setError(null);
    try {
      setStage('Opening the request…');
      const rfq = await api.createRfq({
        assetToken: chosen.token,
        partition,
        quantity: parseAmount(qty, assetDecimals),
        cashToken,
        seller,
        commitWindowSecs: Number(commitWindow),
        revealWindowSecs: Number(revealWindow),
      });

      setStage('Escrowing the block…');
      const simulation = await publicClient.simulateContract({
        address: getAddress(chosen.token),
        abi: holdAbi,
        functionName: 'createHoldByPartition',
        args: [partition as Hex, {
          amount: BigInt(rfq.quantity),
          expirationTimestamp: BigInt(Math.floor(Date.now() / 1000) + DEFAULT_HOLD_SECONDS),
          escrow: getAddress(settlementAddress),
          to: zeroAddress,
          data: '0x',
        }],
        account: getAddress(seller),
      });
      const [accepted, holdId] = simulation.result;
      if (!accepted) throw new Error('ATS refused to create the hold.');
      const txHash = await writeContractAsync(simulation.request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      await api.reportHold(rfq.id, { holdId: Number(holdId), txHash });

      setStage(null);
      onCreated();
    } catch (e) {
      setError(errorCopy(e));
      setStage(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Offer a block"
      subtitle="Escrow size against a new request for quote"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Asset"
          hint={chosen ? `${chosen.name} · ${chosen.assetClass ?? 'security'}` : 'Loading assets…'}
        >
          <Select
            value={assetToken || chosen?.token || ''}
            onChange={(e) => setAssetToken(e.target.value)}
            disabled={!assets?.length}
          >
            {(assets ?? []).map((a) => (
              <option key={a.token} value={a.token}>
                {a.symbol} — {a.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Size"
          error={qtyError}
          hint={`${formatQty(available, assetDecimals)} available to offer`}
          suffix={chosen?.symbol}
        >
          <Input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            inputMode="decimal"
            placeholder="250"
            invalid={Boolean(qtyError)}
          />
        </Field>

        <Field label="Commit window" hint="How long dealers have to submit sealed quotes." suffix="seconds">
          <Input value={commitWindow} onChange={(e) => setCommitWindow(e.target.value)} inputMode="numeric" />
        </Field>

        <Field label="Reveal window" hint="How long they then have to open them." suffix="seconds">
          <Input value={revealWindow} onChange={(e) => setRevealWindow(e.target.value)} inputMode="numeric" />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-2xs text-dim max-w-md leading-relaxed">
          The hold names SottoSettlement as escrow agent and expires in{' '}
          {Math.round(DEFAULT_HOLD_SECONDS / 3600)} hours. A hold with a zero expiry never expires
          and could never be reclaimed, so the venue never sends one.
        </p>
        <Button variant="primary" onClick={submit} disabled={!canSubmit} busy={busy}>
          {stage ?? 'Escrow and open for bids'}
        </Button>
      </div>

      {!isWallet && (
        <div className="mt-3">
          <Callout tone="held" title="Connect the seller wallet to open an RFQ">
            The ATS hold must be signed by the token holder. Demo mode remains read-only so the
            venue never impersonates the seller or handles their key.
          </Callout>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="The request was not opened">
            {error}
          </Callout>
        </div>
      )}
    </Panel>
  );
}

// ----------------------------------------------------------- the active offer

function ActiveOffer({ rfq, cashDecimals }: { rfq: Rfq; cashDecimals: number }) {
  const { data: detail } = useRfq(rfq.id);
  const { data: health } = useHealth();
  const { data: assets } = useAssets();
  const { address, isWallet } = useRole();
  const { sign } = useSignTrade(health?.settlementAddress);
  const qc = useQueryClient();
  const now = useNow();

  const [awarding, setAwarding] = useState(false);
  const [closing, setClosing] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();

  useRfqSubscription(rfq.id);

  const nav = assets?.find((a) => a.token === rfq.assetToken)?.nav ?? null;
  const current = detail?.rfq ?? rfq;

  const unsettledFills = (detail?.fills ?? []).filter(
    (f) => !detail?.settledFillNonces.includes(f.trade.nonce)
  ).length;
  // Not while quotes are still being collected or opened: a seller who pulls the
  // escrow mid-auction has wasted every dealer's commit. Once the book is
  // allocated the remainder is theirs to take back.
  const canRelease =
    isWallet
    && address?.toLowerCase() === current.seller.toLowerCase()
    && current.holdId != null
    && BigInt(current.unfilled) > 0n
    && current.status !== 'OPEN'
    && current.status !== 'REVEALING';

  async function closeWindow() {
    setClosing(true);
    setError(null);
    try {
      await api.closeRfq(rfq.id);
      qc.invalidateQueries({ queryKey: qk.rfq(rfq.id) });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setClosing(false);
    }
  }

  // The hold outlives the request. An RFQ that expires, or one awarded to a
  // dealer who never settled, leaves size escrowed for the full 48 hours unless
  // the seller takes it back - which is what stranded 75 units during testing
  // and left them uncounted as Available. The contract only lets the holder do
  // this, so it is signed here rather than relayed by the venue.
  async function releaseEscrow() {
    if (!publicClient || !health?.settlementAddress || current.holdId == null) return;
    if (!isWallet || !address || address.toLowerCase() !== current.seller.toLowerCase()) {
      setError('Connect the seller wallet that opened this RFQ before releasing the escrow.');
      return;
    }
    setReleasing(true);
    setError(null);
    try {
      const simulation = await publicClient.simulateContract({
        address: getAddress(health.settlementAddress),
        abi: releaseHoldAbi,
        functionName: 'releaseHold',
        args: [
          getAddress(current.assetToken),
          current.partition as Hex,
          getAddress(current.seller),
          BigInt(current.holdId),
          BigInt(current.unfilled),
        ],
        account: getAddress(address),
      });
      const txHash = await writeContractAsync(simulation.request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });
      qc.invalidateQueries({ queryKey: qk.rfq(rfq.id) });
      qc.invalidateQueries({ queryKey: ['balances'] });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setReleasing(false);
    }
  }

  async function award() {
    if (!isWallet || !address || address.toLowerCase() !== current.seller.toLowerCase()) {
      setError('Connect the seller wallet that opened this RFQ before allocating the book.');
      return;
    }
    setAwarding(true);
    setError(null);
    try {
      const result = await api.award(rfq.id);
      for (const fill of result.fills) {
        const sellerSig = await sign(fill.trade);
        sessionStorage.setItem(
          `sotto.sellerSig.${rfq.id}.${fill.trade.nonce}`,
          sellerSig
        );
        await api.submitSellerSignature(rfq.id, fill.trade.nonce, sellerSig);
      }
      qc.invalidateQueries({ queryKey: qk.rfq(rfq.id) });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setAwarding(false);
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        title={
          <span className="flex items-center gap-2">
            Live request
            <StatusPill status={current.status} />
          </span>
        }
        subtitle={`${formatQty(current.quantity, 0)} ${current.assetSymbol} escrowed against hold ${
          current.holdId != null ? `#${current.holdId}` : '—'
        }`}
        right={<div className="flex items-center gap-3">
          {current.status === 'OPEN' && now >= current.commitDeadline && (
            <Button onClick={closeWindow} busy={closing} disabled={closing}>
              Close commit window
            </Button>
          )}
          {canRelease && (
            <Button
              onClick={releaseEscrow}
              busy={releasing}
              disabled={releasing}
              title={
                unsettledFills > 0
                  ? 'Returns the unfilled remainder to your available balance. Fills already awarded and not yet settled are cancelled.'
                  : 'Returns the unfilled remainder to your available balance, without waiting out the 48-hour hold.'
              }
            >
              Release escrow
            </Button>
          )}
          <Link
            href={`/rfq/${current.id}`}
            className="text-xs text-txt underline underline-offset-2 decoration-line hover:decoration-current focusable rounded"
          >
            Settlement view →
          </Link>
        </div>}
        bodyClassName="p-0"
      >
        <div className="px-4 py-3 flex flex-wrap gap-x-8 gap-y-2 text-xs">
          <Meta label="Request" value={<Addr value={current.id} />} />
          <Meta label="Asset" value={<Addr value={current.assetToken} />} />
          {nav && (
            <Meta
              label="NAV mark"
              value={<span className="num text-txt">{formatPrice(nav, cashDecimals)}</span>}
            />
          )}
        </div>
      </Panel>

      {error && (
        <Callout tone="neg" title="The award did not go through">
          {error}
        </Callout>
      )}

      <QuoteBoard
        rfq={current}
        commits={detail?.commits ?? []}
        reveals={detail?.reveals ?? []}
        cashDecimals={cashDecimals}
        nav={nav}
        awardedDealer={detail?.award?.dealer ?? null}
        onAward={isWallet ? award : undefined}
        awarding={awarding}
      />

      {detail?.award && (
        <Callout tone="pos" title="Awarded — the buyer settles from their portal">
          {formatQty(current.filled, 0)} units allocated across {detail.fills.length} fill
          {detail.fills.length === 1 ? '' : 's'}; {formatQty(current.unfilled, 0)} units remain held.
          {' '}Follow it on the{' '}
          <Link href={`/rfq/${current.id}`} className="underline">
            settlement view
          </Link>
          .
        </Callout>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="label">{label}</span>
      {value}
    </span>
  );
}
