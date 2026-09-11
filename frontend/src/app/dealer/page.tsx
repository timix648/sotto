'use client';

// B3 — the dealer portal.
//
// The commit is keccak256(price, quantity, nonce, dealer) and the venue only
// ever receives that hash. Which means the preimage lives in exactly one place:
// this browser. MECHANICS §10 — "A dealer who closes their tab loses the nonce
// and forfeits" — is not a bug to fix, it is a property of the mechanism, so the
// portal stores the preimage immediately and says out loud what is at stake.
//
// On award the two steps are deliberately two buttons: approve the cash, then
// sign the Trade. B3: "Two clear steps, two buttons, never one ambiguous one."
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { usePublicClient, useWriteContract } from 'wagmi';
import { useNativeSigner } from '@/hooks/useNativeSigner';
import { getAddress } from 'viem';
import { Panel, Empty } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Field, Input, Callout } from '@/components/ui/Field';
import { Addr } from '@/components/ui/Addr';
import { StatusPill, Countdown } from '@/components/ui/Status';
import { PageHead } from '@/components/layout/PageHead';
import { Shell } from '@/components/layout/Shell';
import { QuoteBoard } from '@/components/QuoteBoard';
import {
  useHealth, useAssets, useRfqs, useRfq, useBalances, useNow, useRfqSubscription,
  useBatchParams, qk,
} from '@/hooks/useApi';
import { useRole } from '@/hooks/useRole';
import { useSettlementPath } from '@/hooks/useSettlementPath';
import { useCommitStore, type SealedQuote } from '@/hooks/useCommitStore';
import { api, errorCopy } from '@/lib/api';
import { useSignTrade } from '@/lib/sign';
import { erc20Abi } from '@/lib/ats';
import { computeCommit } from '@sotto/shared';
import {
  formatQty, formatCash, formatPrice, formatDate, formatPct, parseAmount, computeNotional,
} from '@/lib/format';
import type { Rfq, Trade } from '@sotto/shared';

export default function DealerPage() {
  const { address, isWallet } = useRole();
  const { data: rfqs } = useRfqs();
  const { data: health } = useHealth();
  const cashDecimals = health?.cashDecimals ?? 6;

  const [selected, setSelected] = useState<string | null>(null);
  const open = useMemo(
    () => (rfqs ?? []).filter((r) => ['OPEN', 'REVEALING', 'AWARDED'].includes(r.status)),
    [rfqs]
  );
  const current = selected ?? open[0]?.id ?? null;

  return (
    <Shell className="space-y-6">
      <PageHead
        title="Dealer"
        blurb="Commit a private quote, reveal it on time and settle if the seller allocates to you."
        address={address}
        isWallet={isWallet}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-1 space-y-4">
          <Panel
            title="Open requests"
            subtitle="Size, asset and terms"
            bodyClassName={open.length ? 'p-0' : 'p-4'}
          >
            {open.length === 0 ? (
              <Empty>No requests are open for quotes right now.</Empty>
            ) : (
              <ul>
                {open.map((r) => (
                  <RequestRow
                    key={r.id}
                    rfq={r}
                    active={r.id === current}
                    onSelect={() => setSelected(r.id)}
                    cashDecimals={cashDecimals}
                  />
                ))}
              </ul>
            )}
          </Panel>

          <SealedQuotes dealer={address} cashDecimals={cashDecimals} />
        </div>

        <div className="lg:col-span-2">
          {current ? (
            <DealerWorkspace rfqId={current} cashDecimals={cashDecimals} />
          ) : (
            <Panel title="Workspace">
              <Empty>Select a request to quote on it.</Empty>
            </Panel>
          )}
        </div>
      </div>
    </Shell>
  );
}

function RequestRow({
  rfq, active, onSelect, cashDecimals,
}: {
  rfq: Rfq;
  active: boolean;
  onSelect: () => void;
  cashDecimals: number;
}) {
  const { data: assets } = useAssets();
  const asset = assets?.find((a) => a.token === rfq.assetToken);

  return (
    <li className="border-b border-line/60 last:border-0">
      <button
        onClick={onSelect}
        className={`w-full px-4 py-3 text-left transition-[transform,background-color] duration-200 hover:translate-x-0.5 focusable ${
          active ? 'bg-raised' : 'hover:bg-wineWash'
        }`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium text-txt">{rfq.assetSymbol}</span>
          <StatusPill status={rfq.status} />
        </div>
        <div className="mt-1 num text-sm text-muted">{formatQty(rfq.quantity, 0)} units</div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-dim">
          {asset?.couponRate != null && <span>coupon {formatPct(asset.couponRate)}</span>}
          {asset?.maturity != null && <span>matures {formatDate(asset.maturity)}</span>}
          {asset?.nav && <span className="num">NAV {formatPrice(asset.nav, cashDecimals)}</span>}
        </div>
      </button>
    </li>
  );
}

// ------------------------------------------------------------- the workspace

function DealerWorkspace({ rfqId, cashDecimals }: { rfqId: string; cashDecimals: number }) {
  const { address, isWallet } = useRole();
  const { path } = useSettlementPath();
  const { data: detail } = useRfq(rfqId);
  const { data: health } = useHealth();
  const { data: assets } = useAssets();
  const { data: balances } = useBalances(address);
  const store = useCommitStore(address);
  const now = useNow();

  useRfqSubscription(rfqId);

  const rfq = detail?.rfq;
  const sealed = store.get(rfqId);
  const myReveal = detail?.reveals.find(
    (r) => address && r.dealer.toLowerCase() === address.toLowerCase()
  );
  const myCommit = detail?.commits.find(
    (c) => address && c.dealer.toLowerCase() === address.toLowerCase()
  );
  const myFill = detail?.fills.find(
    (f) => address && f.dealer.toLowerCase() === address.toLowerCase()
  );
  const won = Boolean(myFill);
  const asset_ = assets?.find((a) => a.token === rfq?.assetToken);
  const nav = asset_?.nav ?? null;
  // The band settle() will actually enforce. Null when no oracle is wired,
  // in which case no price is off-market as far as the contract is concerned.
  const bandBps = asset_?.navBandBps ?? null;

  if (!rfq) {
    return (
      <Panel title="Workspace">
        <div className="h-40 animate-pulse bg-raised rounded" />
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      {!store.storageWorks && (
        <Callout tone="neg" title="This browser will not keep your sealed quote">
          Local storage is unavailable, so the price and nonce behind a commit cannot be saved. If
          you commit now you will not be able to reveal, and the quote is forfeit. Leave private
          browsing, or quote from another browser.
        </Callout>
      )}

      {rfq.status === 'OPEN' && !myCommit && (
        <CommitForm
          rfq={rfq}
          dealer={address}
          cashDecimals={cashDecimals}
          nav={nav}
          bandBps={bandBps}
          store={store}
        />
      )}

      {rfq.status === 'OPEN' && myCommit && (
        <Panel title="Your quote is sealed" subtitle="Nothing readable has left this browser">
          <SealedSummary sealed={sealed} cashDecimals={cashDecimals} rfq={rfq} />
          <div className="mt-3">
            <Countdown deadline={rfq.commitDeadline} label="window closes in" />
          </div>
        </Panel>
      )}

      {rfq.status === 'REVEALING' && (
        <RevealPanel
          rfq={rfq}
          dealer={address}
          sealed={sealed}
          revealed={myReveal}
          cashDecimals={cashDecimals}
          store={store}
          now={now}
        />
      )}

      {/*
        One component for both routes. SettleSteps branches internally: Path A
        shows approve-then-sign, Path B drops the approve step entirely and asks
        for a native signature alongside the EIP-712 one. This used to be a
        hard block telling Path B users to go back to Path A, which was true
        when the native session was connection-only and is not any more.
      */}
      {won && myFill && (
        <SettleSteps
          rfqId={rfqId}
          trade={myFill.trade}
          cashDecimals={cashDecimals}
          settlementAddress={health?.settlementAddress ?? null}
          cashBalance={balances?.cash?.[0]?.balance ?? null}
          allowance={balances?.cash?.[0]?.allowance ?? null}
          settled={detail.settledFillNonces.includes(myFill.trade.nonce)}
          account={address}
          isWallet={isWallet}
          sellerSignature={detail.sellerSignatures[myFill.trade.nonce] ?? null}
        />
      )}

      <QuoteBoard
        rfq={rfq}
        commits={detail?.commits ?? []}
        reveals={detail?.reveals ?? []}
        cashDecimals={cashDecimals}
        nav={nav}
        awardedDealer={detail?.award?.dealer ?? null}
      />
    </div>
  );
}

// ----------------------------------------------------------------- committing

function CommitForm({
  rfq, dealer, cashDecimals, nav, bandBps, store,
}: {
  rfq: Rfq;
  dealer: string | null;
  cashDecimals: number;
  nav: string | null;
  bandBps: number | null;
  store: ReturnType<typeof useCommitStore>;
}) {
  const qc = useQueryClient();
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState(rfq.quantity);
  const [minQuantity, setMinQuantity] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = (() => {
    if (!price.trim()) return null;
    try {
      const base = parseAmount(price, cashDecimals);
      return BigInt(base) > 0n ? base : null;
    } catch {
      return null;
    }
  })();

  const parsedQuantity = (() => {
    try {
      const value = BigInt(parseAmount(quantity, 0));
      return value > 0n && value <= BigInt(rfq.quantity) ? value.toString() : null;
    } catch { return null; }
  })();

  const parsedMinQuantity = (() => {
    if (!parsedQuantity) return null;
    try {
      const value = BigInt(parseAmount(minQuantity, 0));
      return value > 0n && value <= BigInt(parsedQuantity) ? value.toString() : null;
    } catch { return null; }
  })();

  const notional = parsed && parsedQuantity ? computeNotional(parsed, parsedQuantity) : null;

  // Shown before submitting, so the dealer sees exactly what the venue will get.
  const preview = useMemo(() => {
    if (!parsed || !parsedQuantity || !dealer) return null;
    try {
      return computeCommit(
        BigInt(parsed),
        BigInt(parsedQuantity),
        '0x' + '00'.repeat(32) as `0x${string}`,
        dealer as `0x${string}`
      );
    } catch {
      return null;
    }
  }, [parsed, parsedQuantity, dealer]);

  /**
   * Whether settle() would refuse this price.
   *
   * SottoSettlement checks every fill against the NAV oracle and reverts when
   * the price is more than bandBps away from it - with a custom error, so the
   * transaction comes back status 0 at ~60,000 gas and no reason string. A
   * dealer who quoted 1.20 against a NAV of 98.35 found that out only after
   * committing, revealing, winning and approving cash. The band is knowable
   * now, so it is said now. The quote is still allowed: the venue does not
   * decide what a price should be, it only says which ones it will settle.
   */
  const outsideBand = useMemo(() => {
    if (!parsed || !nav || bandBps == null) return null;
    const navUnits = BigInt(nav);
    if (navUnits === 0n) return null;
    const price = BigInt(parsed);
    const spread = price > navUnits ? price - navUnits : navUnits - price;
    if (spread * 10_000n <= navUnits * BigInt(bandBps)) return null;
    const lo = (navUnits * (10_000n - BigInt(bandBps))) / 10_000n;
    const hi = (navUnits * (10_000n + BigInt(bandBps))) / 10_000n;
    return { lo: lo.toString(), hi: hi.toString() };
  }, [parsed, nav, bandBps]);

  async function submit() {
    if (!parsed || !parsedQuantity || !parsedMinQuantity || !dealer) return;
    setBusy(true);
    setError(null);
    try {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      const nonce = ('0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`;
      const commitHash = computeCommit(
        BigInt(parsed),
        BigInt(parsedQuantity),
        nonce,
        dealer as `0x${string}`
      );

      // Save BEFORE the network call. If the POST succeeds and the save has not
      // happened, the quote is unrevealable and therefore lost.
      const saved = store.save({
        rfqId: rfq.id, dealer, price: parsed, quantity: parsedQuantity,
        minQuantity: parsedMinQuantity,
        nonce, commitHash, savedAt: Math.floor(Date.now() / 1000),
      });
      if (!saved) {
        setError('Could not save the price and nonce locally, so the quote was not submitted — you would not be able to reveal it.');
        return;
      }

      await api.commit(rfq.id, { dealer, commitHash });
      setPrice('');
      qc.invalidateQueries({ queryKey: qk.rfq(rfq.id) });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Quote"
      subtitle="Only the hash is submitted. The price stays in this browser until you reveal it."
      right={<Countdown deadline={rfq.commitDeadline} label="closes in" />}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Price"
          hint={`per unit, in cash base units${nav ? ` · NAV mark ${formatPrice(nav, cashDecimals)}` : ''}`}
          suffix="USDC"
        >
          <Input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="98.35"
            inputMode="decimal"
            invalid={Boolean(price.trim()) && !parsed}
          />
        </Field>
        <Field label="Bid size" hint={`Up to ${formatQty(rfq.quantity, 0)} units`} suffix={rfq.assetSymbol}>
          <Input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="numeric"
            invalid={Boolean(quantity) && !parsedQuantity}
          />
        </Field>
        <Field label="Minimum fill" hint="Use the full bid size for all-or-none" suffix={rfq.assetSymbol}>
          <Input
            value={minQuantity}
            onChange={(e) => setMinQuantity(e.target.value)}
            inputMode="numeric"
            invalid={Boolean(minQuantity) && !parsedMinQuantity}
          />
        </Field>
        <Field label="Notional" hint={`${formatQty(parsedQuantity, 0)} units at your price`}>
          <div className="w-full bg-raised border border-line rounded-md px-3 py-2 text-sm num text-txt">
            {notional ? formatCash(notional, cashDecimals) : '—'}
          </div>
        </Field>
      </div>

      {preview && (
        <div className="mt-3 text-2xs text-dim leading-relaxed">
          Your commit is{' '}
          <span className="font-mono text-muted">
            keccak256(price, quantity, nonce, dealer)
          </span>
          . A fresh random nonce is generated when you submit, so the hash below is not the one that
          will be sent — it is here to show that the price alone does not determine it.
        </div>
      )}

      {outsideBand && (
        <div className="mt-3">
          <Callout tone="neg" title="The venue will not settle at this price">
            It sits outside the {(bandBps ?? 0) / 100}% band around the NAV mark of{' '}
            <span className="num">{formatPrice(nav ?? '0', cashDecimals)}</span>. Settlement
            accepts{' '}
            <span className="num">{formatPrice(outsideBand.lo, cashDecimals)}</span> to{' '}
            <span className="num">{formatPrice(outsideBand.hi, cashDecimals)}</span>. You can
            still commit — the band is checked on-chain at settlement, not here — but a winning
            quote outside it reverts and the block goes unfilled.
          </Callout>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Callout tone="held" title="Do not close this tab before you reveal">
          The venue receives only a hash. If this browser loses the price and nonce, nobody can
          reveal your quote and it is forfeit.
        </Callout>
        <Button
          variant="primary"
          onClick={submit}
          disabled={!parsed || !parsedQuantity || !parsedMinQuantity || !dealer || busy}
          busy={busy}
        >
          Seal and submit
        </Button>
      </div>

      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="The quote was not submitted">{error}</Callout>
        </div>
      )}
    </Panel>
  );
}

function SealedSummary({
  sealed, cashDecimals, rfq,
}: {
  sealed: SealedQuote | null;
  cashDecimals: number;
  rfq: Rfq;
}) {
  if (!sealed) {
    return (
      <Callout tone="neg" title="This browser does not hold your preimage">
        A commit exists on the venue for you, but the price and nonce behind it are not in this
        browser&apos;s storage. Unless you have them in the browser you committed from, this quote
        cannot be revealed.
      </Callout>
    );
  }
  return (
    <dl className="grid gap-3 sm:grid-cols-4 text-xs">
      <div>
        <dt className="label">Your price</dt>
        <dd className="num text-base text-txt mt-0.5">
          {formatPrice(sealed.price, cashDecimals)}
        </dd>
      </div>
      <div>
        <dt className="label">Bid size</dt>
        <dd className="num text-base text-txt mt-0.5">
          {formatQty(sealed.quantity, 0)} (min {formatQty(sealed.minQuantity ?? '1', 0)})
        </dd>
      </div>
      <div>
        <dt className="label">Notional</dt>
        <dd className="num text-base text-txt mt-0.5">
          {formatCash(computeNotional(sealed.price, sealed.quantity), cashDecimals)}
        </dd>
      </div>
      <div>
        <dt className="label">Commit</dt>
        <dd className="mt-0.5">
          <Addr value={sealed.commitHash} kind="hash" />
        </dd>
      </div>
    </dl>
  );
}

// ------------------------------------------------------------------ revealing

function RevealPanel({
  rfq, dealer, sealed, revealed, cashDecimals, store, now,
}: {
  rfq: Rfq;
  dealer: string | null;
  sealed: SealedQuote | null;
  revealed: {
    valid: boolean;
    price: string;
    validUntil: number;
    quantity: string;
    minQuantity: string;
  } | undefined;
  cashDecimals: number;
  store: ReturnType<typeof useCommitStore>;
  now: number;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = now > rfq.revealDeadline;

  async function reveal() {
    if (!sealed || !dealer) return;
    setBusy(true);
    setError(null);
    try {
      await api.reveal(rfq.id, {
        dealer,
        price: sealed.price,
        nonce: sealed.nonce,
        quantity: sealed.quantity,
        minQuantity: sealed.minQuantity ?? '1',
        firmnessSecs: 300,
      });
      store.markRevealed(rfq.id, dealer);
      qc.invalidateQueries({ queryKey: qk.rfq(rfq.id) });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  }

  if (revealed) {
    return (
      <Panel title="Revealed" tone={revealed.valid ? 'success' : 'danger'}>
        {revealed.valid ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="label">your price, now public</div>
              <div className="num text-xl text-txt mt-0.5">
                {formatPrice(revealed.price, cashDecimals)}
              </div>
            </div>
            <div className="text-right">
              <div className="label">firm until</div>
              <div className="num text-sm text-muted mt-0.5">
                <Countdown deadline={revealed.validUntil} />
              </div>
              <p className="text-2xs text-dim mt-1 max-w-xs leading-relaxed">
                After this the seller cannot award your quote. Firmness runs from your reveal&apos;s
                own consensus timestamp, not from the request&apos;s close.
              </p>
            </div>
          </div>
        ) : (
          <Callout tone="neg" title="Your reveal did not match its commit">
            The venue recomputed keccak256(price, quantity, nonce, dealer) and got a different hash,
            so the quote is void. This is the mechanism working — a price that can be changed after
            the window closes is not a sealed quote.
          </Callout>
        )}
      </Panel>
    );
  }

  return (
    <Panel
      title="Reveal your quote"
      subtitle="The window is open. An unrevealed quote is forfeit."
      tone="held"
      right={<Countdown deadline={rfq.revealDeadline} label="reveal ends" />}
    >
      {!sealed ? (
        <Callout tone="neg" title="Nothing to reveal from this browser">
          The price and nonce behind your commit are not in this browser&apos;s storage. If you
          committed from another browser or cleared site data, the quote cannot be revealed and is
          forfeit — the venue only ever held the hash.
        </Callout>
      ) : (
        <>
          <SealedSummary sealed={sealed} cashDecimals={cashDecimals} rfq={rfq} />
          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-2xs text-dim max-w-md leading-relaxed">
              Revealing publishes your price and its nonce. The venue recomputes the hash and it
              must match exactly.
            </p>
            <Button variant="primary" onClick={reveal} busy={busy} disabled={expired || busy}>
              {expired ? 'Window closed' : 'Reveal'}
            </Button>
          </div>
        </>
      )}
      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="The reveal was rejected">{error}</Callout>
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------- settling

function SettleSteps({
  rfqId, trade, cashDecimals, settlementAddress, cashBalance, allowance, settled,
  account, isWallet, sellerSignature,
}: {
  rfqId: string;
  trade: Trade;
  cashDecimals: number;
  settlementAddress: string | null;
  cashBalance: string | null;
  allowance: string | null;
  settled: boolean;
  account: string | null;
  isWallet: boolean;
  sellerSignature: string | null;
}) {
  const qc = useQueryClient();
  const { sign } = useSignTrade(settlementAddress);
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { path } = useSettlementPath();
  const native = useNativeSigner();
  const { data: batchParams } = useBatchParams();
  const [approving, setApproving] = useState(false);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Path B grants no allowance at all, so the approve step simply does not
  // apply to it. Saying that out loud is the point of the whole path.
  const pathB = path === 'B';
  const batchReady = Boolean(pathB && batchParams?.available && native.connected);

  const notional = BigInt(trade.notional);
  const approved = (() => {
    try { return BigInt(allowance ?? '0'); } catch { return 0n; }
  })();
  const funded = (() => {
    try { return BigInt(cashBalance ?? '0') >= notional; } catch { return false; }
  })();
  const approvedEnough = approved >= notional;

  async function approve() {
    setApproving(true);
    setError(null);
    try {
      if (!isWallet || !account || account.toLowerCase() !== trade.buyer.toLowerCase()) {
        throw new Error('Connect the awarded dealer wallet before approving cash.');
      }
      if (!settlementAddress || !publicClient) {
        throw new Error('The settlement contract is not available from the live API.');
      }
      const hash = await writeContractAsync({
        address: getAddress(trade.cashToken),
        abi: erc20Abi,
        functionName: 'approve',
        args: [getAddress(settlementAddress), notional],
        account: getAddress(account),
      });
      await publicClient.waitForTransactionReceipt({ hash });
      qc.invalidateQueries({ queryKey: ['balances'] });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setApproving(false);
    }
  }

  /**
   * Path B. The buyer signs a native HTS transfer of their own cash; the venue
   * batches it with the delivery call. No allowance is granted anywhere, and
   * the venue never holds either asset — the network provides the atomicity.
   */
  async function settleBatch() {
    setSettling(true);
    setError(null);
    try {
      if (!isWallet || !account || account.toLowerCase() !== trade.buyer.toLowerCase()) {
        throw new Error('Connect the awarded dealer wallet before signing the Trade.');
      }
      if (!sellerSignature) {
        throw new Error('The seller signature has not reached the venue yet. Ask the seller to finish the award step.');
      }
      if (!batchParams?.available) throw new Error('Path B is not configured on this venue.');
      if (!native.signer || !native.accountId) {
        throw new Error(
          'Connect a Hedera-native wallet session for Path B. If HashPack connected but this ' +
          'still says no session, use its WalletConnect QR rather than the direct button.'
        );
      }

      // A Trade names its parties by EVM address; an HTS transfer moves value
      // between account ids, so both sides are resolved from the mirror node.
      const [buyerAccount, sellerAccount] = await Promise.all([
        api.batchAccount(trade.buyer),
        api.batchAccount(trade.seller),
      ]);
      if (buyerAccount.accountId !== native.accountId) {
        throw new Error(
          `The connected native account ${native.accountId} is not the awarded dealer ` +
          `${buyerAccount.accountId}.`
        );
      }

      // Two signatures, two namespaces: EVM for the Trade, native for the cash.
      const buyerSig = await sign(trade);
      // Loaded on demand. The Hedera SDK is ~1.5MB and only Path B needs it;
      // importing it at module scope put that on every dealer page load,
      // including the Path A visitors who will never touch it.
      const { signCashLeg } = await import('@/lib/batch');
      const innerCashTxBase64 = await signCashLeg({
        signer: native.signer,
        params: batchParams,
        buyerAccountId: buyerAccount.accountId,
        sellerAccountId: sellerAccount.accountId,
        notional: trade.notional,
      });

      await api.settleBatch(rfqId, { trade, sellerSig: sellerSignature, buyerSig, innerCashTxBase64 });
      qc.invalidateQueries({ queryKey: qk.rfq(rfqId) });
      qc.invalidateQueries({ queryKey: ['balances'] });
    } catch (e) {
      setError(errorCopy(e));
      qc.invalidateQueries({ queryKey: qk.rfq(rfqId) });
      qc.invalidateQueries({ queryKey: ['balances'] });
    } finally {
      setSettling(false);
    }
  }

  async function settle() {
    setSettling(true);
    setError(null);
    try {
      if (!isWallet || !account || account.toLowerCase() !== trade.buyer.toLowerCase()) {
        throw new Error('Connect the awarded dealer wallet before signing the Trade.');
      }
      if (!sellerSignature) {
        throw new Error('The seller signature has not reached the venue yet. Ask the seller to finish the award step.');
      }
      const buyerSig = await sign(trade);

      await api.settle(rfqId, { trade, sellerSig: sellerSignature, buyerSig });
      qc.invalidateQueries({ queryKey: qk.rfq(rfqId) });
      qc.invalidateQueries({ queryKey: ['balances'] });
    } catch (e) {
      setError(errorCopy(e));
      qc.invalidateQueries({ queryKey: qk.rfq(rfqId) });
      qc.invalidateQueries({ queryKey: ['balances'] });
    } finally {
      setSettling(false);
    }
  }

  if (settled) {
    return (
      <Callout tone="pos" title="Settled">
        Both legs moved in one transaction.{' '}
        <Link href={`/rfq/${rfqId}`} className="underline">
          Open the settlement view
        </Link>
        .
      </Callout>
    );
  }

  return (
    <Panel
      title="You won this block"
      subtitle="Two steps. Approve the cash, then sign the Trade."
      tone="held"
    >
      <div className="grid gap-3 sm:grid-cols-3 text-xs mb-4">
        <Stat label="Quantity" value={formatQty(trade.quantity, 0)} />
        <Stat label="Notional" value={formatCash(trade.notional, cashDecimals)} />
        <Stat
          label="Your cash"
          value={formatCash(cashBalance, cashDecimals)}
          tone={funded ? undefined : 'neg'}
        />
      </div>

      <ol className="space-y-2">
        {pathB ? (
          <>
            <Step
              n={1}
              done={native.connected}
              title={native.connected
                ? `Hedera-native session ${native.accountId}`
                : 'Connect a Hedera-native wallet — Path B grants no allowance'}
            />
            <Step
              n={2}
              done={false}
              title="Sign the Trade and your own cash leg"
              action={
                <Button
                  variant="primary"
                  onClick={settleBatch}
                  busy={settling}
                  disabled={settling || !batchReady || !funded || !isWallet || !sellerSignature}
                >
                  Sign and settle
                </Button>
              }
            />
          </>
        ) : (
          <>
            <Step
              n={1}
              done={approvedEnough}
              title={approvedEnough
                ? `Approved ${formatCash(approved, cashDecimals)}`
                : 'Approve the settlement contract for the exact notional'}
              action={
                !approvedEnough ? (
                  <Button onClick={approve} busy={approving} disabled={!funded || !isWallet}>
                    Approve {formatCash(trade.notional, cashDecimals)}
                  </Button>
                ) : null
              }
            />
            <Step
              n={2}
              done={false}
              title="Sign the Trade and settle"
              action={
                <Button
                  variant="primary"
                  onClick={settle}
                  busy={settling}
                  disabled={settling || !approvedEnough || !isWallet || !sellerSignature}
                >
                  Sign and settle
                </Button>
              }
            />
          </>
        )}
      </ol>

      {pathB && (
        <div className="mt-3">
          <Callout
            tone={native.connected ? 'muted' : 'held'}
            title={native.connected
              ? 'Path B — each party signs only its own leg'
              : 'Path B needs a Hedera-native wallet session'}
          >
            {native.connected ? (
              <>
                You sign a native HTS transfer of your own cash and the EIP-712 Trade. The venue
                signs delivery and submits both as one HIP-551 batch. No allowance is granted
                anywhere, and the network — not the contract — guarantees both legs or neither.
              </>
            ) : (
              <>
                Connect a Hedera-native session (HashPack or Kabila). If your wallet connected but
                this still says no session, it gave an EVM session instead — use its WalletConnect
                QR rather than the direct button.
              </>
            )}
          </Callout>
        </div>
      )}

      {!funded && (
        <div className="mt-3">
          <Callout tone="neg" title="Your cash balance is short of the notional">
            Settlement would revert at the cash leg. Neither leg would move — which is the correct
            behaviour, but it means this trade cannot complete until the account is funded.
          </Callout>
        </div>
      )}

      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="Settlement did not complete">
            {error}{' '}
            <Link href={`/rfq/${rfqId}`} className="underline">
              See what moved
            </Link>
            .
          </Callout>
        </div>
      )}
    </Panel>
  );
}

function Step({
  n, title, done, action,
}: {
  n: number;
  title: string;
  done: boolean;
  action?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 rounded-md border border-line bg-raised">
      <span
        className={`h-5 w-5 shrink-0 rounded-full border grid place-items-center text-2xs ${
          done ? 'border-pos/50 text-pos' : 'border-line text-muted'
        }`}
      >
        {done ? '✓' : n}
      </span>
      <span className="flex-1 text-xs text-txt">{title}</span>
      {action}
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'neg' }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className={`num text-base mt-0.5 ${tone === 'neg' ? 'text-neg' : 'text-txt'}`}>{value}</div>
    </div>
  );
}

// -------------------------------------------------------------- saved quotes

function SealedQuotes({ dealer, cashDecimals }: { dealer: string | null; cashDecimals: number }) {
  const store = useCommitStore(dealer);
  if (!store.mine.length) return null;

  return (
    <Panel
      title="Sealed quotes in this browser"
      subtitle="The only copy of these preimages"
      bodyClassName="p-0"
    >
      <ul>
        {store.mine.map((q) => (
          <li key={q.rfqId + q.dealer} className="px-4 py-2.5 border-b border-line/60 last:border-0">
            <div className="flex items-center justify-between gap-3">
              <Addr value={q.rfqId} />
              <span className="num text-xs text-txt">{formatPrice(q.price, cashDecimals)}</span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-3 text-2xs text-dim">
              <Addr value={q.commitHash} kind="hash" />
              <span>{q.revealedAt ? 'revealed' : 'sealed'}</span>
            </div>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
