'use client';

// B2 — the seller portal.
//
// The order of this page is the order of the story: the position first (the
// four numbers), then the offer that moves two of them, then the sealed board
// the offer produces. A viewer should be able to follow it without narration.
import { useCallback, useMemo, useState } from 'react';
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
import { holdAbi, holdReadAbi, releaseHoldAbi, DEFAULT_HOLD_SECONDS } from '@/lib/ats';
import { formatQty, formatPrice, parseAmount } from '@/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  // A finished request can still hold units: the remainder of a partial fill, or
  // everything, when the request failed. Nothing on-chain releases it, and the
  // button on the live request is out of reach once the request is no longer
  // live - which is precisely when a seller needs it.
  const finished = useMemo(
    () => past.filter((r) => r.holdId != null && ['SETTLED', 'FAILED', 'EXPIRED'].includes(r.status)),
    [past]
  );

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
            emptyMessage="No finished requests yet."
            assetDecimals={position?.decimals ?? 0}
            dense
          />
        </div>
      </div>

      <StrandedEscrow rfqs={finished} assetDecimals={position?.decimals ?? 0} />
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

/**
 * Return a request's escrow to the seller.
 *
 * Shared because there are two places a seller needs it and they are not the
 * same moment. One is a request still on screen. The other is a request that
 * has already finished - and that is the common case, because a hold outlives
 * the request that created it: 23 of 30 units fill, the RFQ settles, and the
 * remaining 7 sit escrowed with nothing on-chain aware the auction is over.
 *
 * Returns the number of units freed; 0 means the hold was already empty.
 */
function useReleaseEscrow() {
  const { address } = useRole();
  const { data: health } = useHealth();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const qc = useQueryClient();

  return useCallback(
    async (rfq: Rfq): Promise<bigint> => {
      if (!publicClient) throw new Error('No RPC client.');
      if (!health?.settlementAddress) throw new Error('The venue has not reported a settlement address.');
      if (rfq.holdId == null) throw new Error('This request never escrowed a hold.');
      if (!address || address.toLowerCase() !== rfq.seller.toLowerCase()) {
        throw new Error('Connect the seller wallet that opened this request before releasing its escrow.');
      }

      // Release what the HOLD still contains, not what the engine calls
      // unfilled. Those differ whenever a fill was awarded and never settled:
      // the units are allocated in the book but have not left the escrow, so a
      // request reading filled 23 / unfilled 2 can still be sitting on all 25.
      // Releasing `unfilled` there frees 2 and strands 23. The hold is the
      // truth - executeHoldByPartition decrements it as fills actually settle.
      const [heldNow] = await publicClient.readContract({
        address: getAddress(rfq.assetToken),
        abi: holdReadAbi,
        functionName: 'getHoldForByPartition',
        args: [{
          partition: rfq.partition as Hex,
          tokenHolder: getAddress(rfq.seller),
          holdId: BigInt(rfq.holdId),
        }],
      });
      if (heldNow === 0n) return 0n;

      const simulation = await publicClient.simulateContract({
        address: getAddress(health.settlementAddress),
        abi: releaseHoldAbi,
        functionName: 'releaseHold',
        args: [
          getAddress(rfq.assetToken),
          rfq.partition as Hex,
          getAddress(rfq.seller),
          BigInt(rfq.holdId),
          heldNow,
        ],
        account: getAddress(address),
      });
      const txHash = await writeContractAsync(simulation.request);
      await publicClient.waitForTransactionReceipt({ hash: txHash });

      qc.invalidateQueries({ queryKey: qk.rfq(rfq.id) });
      qc.invalidateQueries({ queryKey: ['balances'] });
      qc.invalidateQueries({ queryKey: ['rfqs'] });
      return heldNow;
    },
    [address, health?.settlementAddress, publicClient, writeContractAsync, qc]
  );
}

// --------------------------------------------------------- escrow left behind

/**
 * Holds that outlived their request.
 *
 * An ATS hold runs for 48 hours on its own clock and knows nothing about the
 * RFQ that created it. Fill 23 of 30 and the other 7 stay escrowed; fail to
 * settle at all and the whole block does. The seller sees the size vanish from
 * Available with nothing on screen explaining where it went or how to get it
 * back, because the request it belonged to is finished and off the live panel.
 *
 * Each row asks the chain what its hold actually contains, so a request that
 * has already been released simply does not appear.
 */
function StrandedEscrow({ rfqs, assetDecimals }: { rfqs: Rfq[]; assetDecimals: number }) {
  if (!rfqs.length) return null;
  return (
    <div className="space-y-2">
      {rfqs.map((r) => (
        <StrandedRow key={r.id} rfq={r} assetDecimals={assetDecimals} />
      ))}
    </div>
  );
}

function StrandedRow({ rfq, assetDecimals }: { rfq: Rfq; assetDecimals: number }) {
  const publicClient = usePublicClient();
  const { address, isWallet } = useRole();
  const releaseHold = useReleaseEscrow();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: held } = useQuery({
    queryKey: ['hold', rfq.assetToken, rfq.seller, rfq.holdId],
    enabled: Boolean(publicClient && rfq.holdId != null),
    refetchInterval: 15_000,
    queryFn: async () => {
      const [amount] = await publicClient!.readContract({
        address: getAddress(rfq.assetToken),
        abi: holdReadAbi,
        functionName: 'getHoldForByPartition',
        args: [{
          partition: rfq.partition as Hex,
          tokenHolder: getAddress(rfq.seller),
          holdId: BigInt(rfq.holdId as number),
        }],
      });
      return amount.toString();
    },
  });

  // Nothing escrowed, nothing to say.
  if (!held || held === '0') return null;

  const mine = isWallet && address?.toLowerCase() === rfq.seller.toLowerCase();

  async function release() {
    setBusy(true);
    setError(null);
    try {
      await releaseHold(rfq);
      qc.invalidateQueries({ queryKey: ['hold', rfq.assetToken, rfq.seller, rfq.holdId] });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Escrow still held"
      subtitle={`Hold #${rfq.holdId} from a request that is ${rfq.status.toLowerCase()}`}
      right={mine ? (
        <Button onClick={release} busy={busy} disabled={busy}>
          Release {formatQty(held, assetDecimals)} {rfq.assetSymbol}
        </Button>
      ) : undefined}
    >
      <div className="text-xs text-muted">
        <span className="num text-txt">{formatQty(held, assetDecimals)}</span>{' '}
        {rfq.assetSymbol} {held === '1' ? 'is' : 'are'} escrowed against request{' '}
        <Addr value={rfq.id} />, which is no longer trading. The ATS hold runs for 48 hours
        whatever the venue thinks, so these units stay out of your available balance until you
        release them or the hold expires. Only you can do it — the venue cannot touch your
        escrow.
      </div>
      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="The escrow was not released">{error}</Callout>
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
  const releaseHold = useReleaseEscrow();

  useRfqSubscription(rfq.id);

  const nav = assets?.find((a) => a.token === rfq.assetToken)?.nav ?? null;
  const current = detail?.rfq ?? rfq;

  const unsettledFills = (detail?.fills ?? []).filter(
    (f) => !detail?.settledFillNonces.includes(f.trade.nonce)
  ).length;
  // Not while quotes are still being collected or opened: a seller who pulls the
  // escrow mid-auction has wasted every dealer's commit. Once the book is
  // allocated the remainder is theirs to take back.
  //
  // Deliberately not gated on unfilled > 0. A request can read unfilled 0 and
  // still hold every unit, because an awarded fill only leaves the escrow when
  // it settles - which is exactly the case a seller most needs this button for.
  // How much there is to release is read from the hold when the button is used.
  const canRelease =
    isWallet
    && address?.toLowerCase() === current.seller.toLowerCase()
    && current.holdId != null
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
    setError(null);
    setReleasing(true);
    try {
      const freed = await releaseHold(current);
      if (freed === 0n) {
        setError('This hold is already empty - nothing is escrowed against this request.');
      }
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
                  ? `Returns everything still escrowed to your available balance. ${unsettledFills} awarded fill${unsettledFills === 1 ? '' : 's'} not yet settled would be cancelled.`
                  : 'Returns everything still escrowed to your available balance, without waiting out the 48-hour hold.'
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
