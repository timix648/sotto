'use client';

// B1 — the issuer portal.
//
// The KYC toggle is the most important control in this build. BLUEPRINT B1:
// "This toggle is what you flip on camera to trigger the failed settlement.
// Make it prominent." It is the first panel, not the last.
//
// The issue form reflects what ATS actually accepts, not what §A2 of the
// blueprint assumed. ATS-SPIKE is explicit: coupon rate and frequency are NOT
// issuance parameters — they are set after creation via `Bond.setCoupon()`, so
// issuance is two steps. Showing them as one form would misrepresent the
// contract and produce a confusing failure.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Panel, Empty } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Callout } from '@/components/ui/Field';
import { Addr, HashScanLink } from '@/components/ui/Addr';
import { PageHead } from '@/components/layout/PageHead';
import { Shell } from '@/components/layout/Shell';
import { useHealth, useAssets, useNav, useLifecycle, qk } from '@/hooks/useApi';
import { useRole } from '@/hooks/useRole';
import { api, errorCopy, type Asset, type Health, type RedeemResult } from '@/lib/api';
import { hashscan } from '@/lib/hashscan';
import {
  formatDate, formatCash, formatPct, formatQty, formatPrice, formatClock,
  countdown, parseAmount, toInputValue,
} from '@/lib/format';
import { cn } from '@/lib/cn';

export default function IssuerPage() {
  const { address, isWallet, demoMode, role } = useRole();
  const { data: assets } = useAssets();
  const { data: health } = useHealth();
  const [assetToken, setAssetToken] = useState<string | null>(null);

  const asset = assets?.find((a) => a.token === assetToken) ?? assets?.[0] ?? null;
  const issuerDemo = demoMode && role === 'issuer';

  return (
    <Shell className="space-y-6">
      <PageHead
        title="Issuer"
        blurb="Manage issuance and transfer eligibility for the live ATS security."
        address={address}
        isWallet={isWallet}
      />

      {!issuerDemo && (
        <Callout
          tone="muted"
          title="Issuer actions require the explicit demo desk"
          action={<Link href="/enter" className="font-medium text-txt underline underline-offset-4">Choose the issuer demo</Link>}
        >
          These testnet controls use the local backend issuer key. They stay read-only until you
          deliberately enter that demo; production will require authenticated issuer-wallet signing.
        </Callout>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3 space-y-4">
          <KycPanel assets={assets} health={health} enabled={issuerDemo} />
          <IssueForm asset={asset} accounts={health?.accounts} enabled={issuerDemo} />
          <NavPanel
            asset={asset}
            health={health}
            cashDecimals={health?.cashDecimals ?? 6}
            enabled={issuerDemo}
          />
        </div>

        <div className="lg:col-span-2 space-y-4">
          <AssetPicker assets={assets} selected={asset} onSelect={(t) => setAssetToken(t)} />
          <CouponSchedule asset={asset} cashDecimals={health?.cashDecimals ?? 6} />
        </div>
      </div>

      <RedemptionPanel health={health} cashDecimals={health?.cashDecimals ?? 6} enabled={issuerDemo} />
    </Shell>
  );
}

// ------------------------------------------------------------ the KYC toggle

function KycPanel({
  assets, health, enabled,
}: {
  assets: Asset[] | undefined;
  health: ReturnType<typeof useHealth>['data'];
  enabled: boolean;
}) {
  const qc = useQueryClient();
  const [assetToken, setAssetToken] = useState('');
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState<'grant' | 'revoke' | null>(null);
  const [result, setResult] = useState<{ granted: boolean; txHash: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = assets?.find((a) => a.token === assetToken) ?? assets?.[0] ?? null;
  const parties = health?.accounts;

  const known = useMemo(
    () =>
      [
        { label: 'Dealer (demo buyer)', addr: parties?.dealer },
        { label: 'Seller', addr: parties?.seller },
        { label: 'Issuer', addr: parties?.issuer },
      ].filter((x): x is { label: string; addr: string } => Boolean(x.addr)),
    [parties]
  );

  const target = account || known[0]?.addr || '';
  const valid = /^0x[a-fA-F0-9]{40}$/.test(target);

  async function set(granted: boolean) {
    if (!enabled || !chosen || !valid) return;
    setBusy(granted ? 'grant' : 'revoke');
    setError(null);
    setResult(null);
    try {
      const res = await api.kyc({ assetToken: chosen.token, account: target, granted });
      setResult({ granted, txHash: res.txHash });
      qc.invalidateQueries({ queryKey: qk.assets });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel
      title="Compliance — KYC"
      subtitle="Enforced by ATS inside executeHoldByPartition. Revoke it and the next settlement reverts, with neither leg moving."
      tone="held"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Asset">
          <Select value={assetToken || chosen?.token || ''} onChange={(e) => setAssetToken(e.target.value)}>
            {(assets ?? []).map((a) => (
              <option key={a.token} value={a.token}>
                {a.symbol}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Account"
          error={target && !valid ? 'Not a 20-byte EVM address.' : null}
          hint="The party whose transfer permission you are changing."
        >
          <Select value={target} onChange={(e) => setAccount(e.target.value)}>
            {known.map((k) => (
              <option key={k.addr} value={k.addr}>
                {k.label} — {k.addr.slice(0, 10)}…{k.addr.slice(-4)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant="ghost" onClick={() => set(true)} busy={busy === 'grant'} disabled={!enabled || !valid || Boolean(busy)}>
          Grant KYC
        </Button>
        <Button variant="danger" onClick={() => set(false)} busy={busy === 'revoke'} disabled={!enabled || !valid || Boolean(busy)}>
          Revoke KYC
        </Button>
        <p className="text-2xs text-dim flex-1 min-w-[16rem] leading-relaxed">
          Revoking does not touch the venue, the RFQ or the hold. The trade can still be quoted,
          awarded and signed — it fails at the transfer, which is the whole point.
        </p>
      </div>

      {result && (
        <div className="mt-3">
          <Callout
            tone={result.granted ? 'pos' : 'neg'}
            title={result.granted ? 'KYC granted' : 'KYC revoked — the next settlement for this account will revert'}
          >
            <span className="inline-flex items-center gap-2">
              <Addr value={result.txHash} kind="hash" href={hashscan.tx(result.txHash)} />
            </span>
          </Callout>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="The change did not go through">{error}</Callout>
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------- issuing units

function IssueForm({
  asset, accounts, enabled,
}: {
  asset: Asset | null;
  accounts: Health['accounts'];
  enabled: boolean;
}) {
  const qc = useQueryClient();
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('100');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ assetToken: string; txHash: string } | null>(null);
  const parties = [
    { label: 'Seller', address: accounts?.seller },
    { label: 'Dealer', address: accounts?.dealer },
    { label: 'Issuer', address: accounts?.issuer },
  ].filter((p): p is { label: string; address: string } => Boolean(p.address));
  const target = recipient || parties[0]?.address || '';
  const validTarget = /^0x[a-fA-F0-9]{40}$/.test(target);
  const validAmount = (() => {
    try { return BigInt(amount) > 0n; } catch { return false; }
  })();
  const canSubmit = Boolean(enabled && asset && validTarget && validAmount && !busy);

  async function submit() {
    if (!enabled) return;
    setBusy(true);
    setError(null);
    setIssued(null);
    try {
      const res = await api.issue({
        to: target,
        amount,
      });
      setIssued(res);
      qc.invalidateQueries({ queryKey: qk.assets });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Issue units"
      subtitle="Mint units of the deployed ATS security to an approved account. Contract deployment remains an operator workflow."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Asset" hint="The live API currently issues the deployed bond contract.">
          <div className="w-full rounded-md border border-line bg-raised px-3 py-2 text-sm text-txt">
            {asset ? `${asset.symbol} — ${asset.name}` : 'Loading asset…'}
          </div>
        </Field>
        <Field label="Recipient" hint="KYC must be granted before issuance.">
          <Select value={target} onChange={(e) => setRecipient(e.target.value)}>
            {parties.map((party) => (
              <option key={party.address} value={party.address}>
                {party.label} — {party.address.slice(0, 10)}…{party.address.slice(-4)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Units" suffix={asset?.symbol}>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" invalid={!validAmount} />
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-2xs text-dim max-w-md leading-relaxed">
          This calls <span className="font-mono">issueByPartition</span> on the existing ATS token.
          It does not deploy a new contract or change settlement.
        </p>
        <Button variant="primary" onClick={submit} disabled={!canSubmit} busy={busy}>
          Issue units
        </Button>
      </div>

      {issued && (
        <div className="mt-3">
          <Callout tone="pos" title="Issued">
            <span className="inline-flex flex-wrap items-center gap-3">
              <Addr value={issued.assetToken} href={hashscan.contract(issued.assetToken)} />
              <Addr value={issued.txHash} kind="hash" href={hashscan.tx(issued.txHash)} />
            </span>
          </Callout>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="Issuance failed">{error}</Callout>
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------- the band reference

/**
 * The NAV the settlement band checks against, and how old it is.
 *
 * This panel exists because the guard was previously INVISIBLE until it fired.
 * A reference older than the oracle's maxAge makes every settlement revert at
 * about 59,000 gas with nothing readable in the message - which looks like a
 * broken venue rather than a control doing its job. Showing the age up front
 * turns a mystery revert into a stated reason, and publishing is one click.
 *
 * Nothing republishes on a timer, deliberately. An automated re-stamp of an
 * unchanging number would leave the staleness bound looking intact on-chain
 * while making it impossible for it ever to fire - a weaker guarantee than the
 * 24h bound, and an invisible one. A fund administrator strikes a NAV and
 * publishes it. This is that, with a button.
 */
function NavPanel({
  asset, health, cashDecimals, enabled,
}: {
  asset: Asset | null;
  health: Health | undefined;
  cashDecimals: number;
  enabled: boolean;
}) {
  const qc = useQueryClient();
  const token = asset?.token ?? health?.bondAddress ?? null;
  const { data: nav, isLoading } = useNav(token);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);

  // Prefill with whatever is on-chain, so republishing an unchanged NAV - the
  // common case - is a single click with nothing to retype.
  const current = nav?.price ? toInputValue(nav.price, nav.decimals ?? cashDecimals) : '';
  const value = price || current;
  const parsed = (() => {
    try {
      const raw = parseAmount(value, nav?.decimals ?? cashDecimals);
      return BigInt(raw) > 0n ? raw : null;
    } catch { return null; }
  })();

  const marketFed = nav?.source === 'market-feed';
  const stale = Boolean(nav && !nav.fresh);

  async function publish() {
    if (!enabled || !token || !parsed) return;
    setBusy(true);
    setError(null);
    setPublished(null);
    try {
      const res = await api.publishNav({
        assetToken: token, price: parsed, decimals: nav?.decimals ?? cashDecimals,
      });
      setPublished(res.txHash);
      setPrice('');
      qc.invalidateQueries({ queryKey: qk.nav(token) });
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Reference NAV"
      subtitle="The price the settlement band checks every trade against. A reference older than the bound is refused on-chain, so no trade can settle until it is republished."
      tone={stale ? 'danger' : 'default'}
      right={
        nav && (
          <span className={cn('text-2xs uppercase tracking-wider', nav.fresh ? 'text-pos' : 'text-neg')}>
            {nav.fresh ? 'fresh' : 'stale'}
          </span>
        )
      }
    >
      {isLoading && <p className="text-sm text-dim">Reading the oracle…</p>}

      {nav && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <span className="label">reference</span>
              <div className="num text-lg text-txt">
                {nav.price ? formatPrice(nav.price, nav.decimals) : '—'}
              </div>
              <div className="mt-0.5 text-2xs text-dim">per 100 nominal</div>
            </div>
            <div>
              <span className="label">age</span>
              <div className={cn('num text-lg', nav.fresh ? 'text-txt' : 'text-neg')}>
                {nav.ageSeconds == null ? '—' : formatAge(nav.ageSeconds)}
              </div>
              <div className="mt-0.5 text-2xs text-dim">
                bound {formatAge(nav.maxAge)}
              </div>
            </div>
            <div>
              <span className="label">source</span>
              <div className="text-sm text-txt mt-1">
                {nav.source === 'market-feed' ? 'Chainlink feed' :
                 nav.source === 'administrator' ? 'Administrator' : 'None published'}
              </div>
              {nav.updatedAt != null && (
                <div className="mt-0.5 text-2xs text-dim num">{formatClock(nav.updatedAt)}</div>
              )}
            </div>
          </div>

          {stale && (
            <div className="mt-4">
              <Callout tone="neg" title="Trading is blocked until this is republished">
                The band guard refuses a reference older than {formatAge(nav.maxAge)}. A settlement
                attempted now reverts on-chain with both ledgers untouched — that is the control
                working, not a fault.
              </Callout>
            </div>
          )}

          {marketFed && (
            <div className="mt-4">
              <Callout tone="muted" title="This asset is priced by a market feed">
                A configured <span className="font-mono">IPriceSource</span> wins over an
                administrator publication, so the band reads Chainlink for this asset and
                publishing here has no effect on it.
              </Callout>
            </div>
          )}

          {!marketFed && (
            <>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <Field
                  label="Publish NAV"
                  suffix="per 100"
                  hint="A bond's NAV comes from the administrator, not a price feed."
                  error={value && !parsed ? 'Must be a positive number.' : null}
                >
                  <Input
                    value={value}
                    onChange={(e) => setPrice(e.target.value)}
                    inputMode="decimal"
                    invalid={Boolean(value) && !parsed}
                  />
                </Field>
              </div>

              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-2xs text-dim max-w-md leading-relaxed">
                  Calls <span className="font-mono">publishNav</span> on the deployed oracle. It
                  cannot move funds — the band can only ever refuse a trade.
                </p>
                <Button
                  variant={stale ? 'primary' : 'ghost'}
                  onClick={publish}
                  busy={busy}
                  disabled={!enabled || !parsed || busy}
                >
                  Publish NAV
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {published && (
        <div className="mt-3">
          <Callout tone="pos" title="Published — the band has a fresh reference">
            <Addr value={published} kind="hash" href={hashscan.tx(published)} />
          </Callout>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="The NAV was not published">{error}</Callout>
        </div>
      )}
    </Panel>
  );
}

// ---------------------------------------------------- redemption at maturity

/**
 * The last leg of the bond lifecycle, on a button.
 *
 * Two things this has to say out loud, because both are properties rather than
 * quirks. Maturity is a HARD on-chain gate: fullRedeemAtMaturity is guarded by
 * onlyAfterCurrentMaturityDate, so an early redemption is refused by the chain,
 * not by us. And maturity only ever moves FORWARD, which is why this runs
 * against a short-dated note rather than the 2030 senior bond - that one can
 * never be matured early by anybody, including the issuer.
 *
 * The principal is paid BEFORE the units are burned. ATS burns and does not
 * move money, so paying second would let a failure leave a holder with neither
 * units nor cash.
 */
function RedemptionPanel({
  health, cashDecimals, enabled,
}: {
  health: Health | undefined;
  cashDecimals: number;
  enabled: boolean;
}) {
  const qc = useQueryClient();
  const token = health?.shortBondAddress ?? null;
  const parties = [
    { label: 'Seller', address: health?.accounts?.seller },
    { label: 'Dealer', address: health?.accounts?.dealer },
    { label: 'Issuer', address: health?.accounts?.issuer },
  ].filter((p): p is { label: string; address: string } => Boolean(p.address));

  const [holder, setHolder] = useState('');
  const target = holder || parties[0]?.address || '';
  const { data: life } = useLifecycle(token, target);

  const [busy, setBusy] = useState<'issue' | 'redeem' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RedeemResult | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  const units = (() => { try { return BigInt(life?.holderUnits ?? '0'); } catch { return 0n; } })();
  const canRedeem = Boolean(enabled && life?.matured && units > 0n && life?.issuerCanPay && !busy);

  function refresh() {
    if (token) qc.invalidateQueries({ queryKey: qk.lifecycle(token, target) });
    qc.invalidateQueries({ queryKey: qk.assets });
  }

  async function reload() {
    if (!enabled || !token) return;
    setBusy('issue');
    setError(null);
    try {
      // Redemption burns the holder's whole position, so a second run needs the
      // note reloaded. Issuing is the issuer's own call, same as anywhere else.
      await api.issue({ assetToken: token, to: target, amount: '10' });
      refresh();
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(null);
    }
  }

  async function redeem() {
    if (!canRedeem || !token) return;
    setBusy('redeem');
    setError(null);
    setResult(null);
    try {
      const res = await api.redeem({ assetToken: token, holder: target });
      setResult(res);
      refresh();
    } catch (e) {
      setError(errorCopy(e));
    } finally {
      setBusy(null);
    }
  }

  if (!token) return null;

  return (
    <Panel
      title="Redemption at maturity"
      subtitle="Issuance, trading and redemption — the third leg. The units are burned by ATS against the maturity date; the principal is paid first, because units are the holder's claim on that cash."
      tone={life?.matured ? 'success' : 'held'}
      right={
        life && (
          <span className={cn('text-2xs uppercase tracking-wider', life.matured ? 'text-pos' : 'text-held')}>
            {life.matured ? 'matured' : `matures in ${countdown(life.maturityDate, now)}`}
          </span>
        )
      }
    >
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3 grid gap-4 sm:grid-cols-2">
          <Field label="Instrument" hint="A short-dated note. Maturity can only move forward, so the 2030 bond can never be matured on demand.">
            <div className="w-full rounded-md border border-line bg-raised px-3 py-2 text-sm text-txt">
              {life ? `${life.symbol} — ${life.name}` : 'Reading the bond…'}
            </div>
          </Field>
          <Field label="Holder" hint="Every unit this account holds is redeemed.">
            <Select value={target} onChange={(e) => setHolder(e.target.value)}>
              {parties.map((party) => (
                <option key={party.address} value={party.address}>
                  {party.label} — {party.address.slice(0, 10)}…{party.address.slice(-4)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="lg:col-span-2 grid grid-cols-3 gap-3 content-start">
          <div>
            <span className="label">units</span>
            <div className="num text-lg text-txt">{formatQty(life?.holderUnits, 0)}</div>
          </div>
          <div>
            <span className="label">principal</span>
            <div className="num text-lg text-txt">{formatCash(life?.principalDue, cashDecimals)}</div>
          </div>
          <div>
            <span className="label">maturity</span>
            <div className="num text-sm text-muted mt-1.5">{formatDate(life?.maturityDate)}</div>
          </div>
        </div>
      </div>

      {life && !life.matured && (
        <div className="mt-4">
          <Callout tone="held" title="The chain will refuse this until the maturity date">
            <span className="font-mono">fullRedeemAtMaturity</span> is guarded by{' '}
            <span className="font-mono">onlyAfterCurrentMaturityDate</span>. Called early it reverts
            with <span className="font-mono">BondMaturityDateWrong()</span> — a venue that only
            checked maturity in its own backend would have redeemed this holder early.
          </Callout>
        </div>
      )}

      {life?.matured && units === 0n && (
        <div className="mt-4">
          <Callout tone="muted" title="Nothing to redeem">
            This holder has no units of the note. Redemption burns the whole position, so a repeat
            demonstration needs it reloaded first.
          </Callout>
        </div>
      )}

      {life && units > 0n && !life.issuerCanPay && (
        <div className="mt-4">
          <Callout tone="neg" title="The issuer cannot pay the principal">
            Owed {formatCash(life.principalDue, cashDecimals)}, holding{' '}
            {formatCash(life.issuerCash, cashDecimals)}. The burn is deliberately not offered: the
            units are the holder&apos;s claim on that cash.
          </Callout>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-2xs text-dim max-w-lg leading-relaxed">
          Pays {formatCash(life?.principalDue, cashDecimals)} in{' '}
          {life?.currency ?? 'USD'}, then calls{' '}
          <span className="font-mono">fullRedeemAtMaturity</span>. Both legs land on the public HCS
          audit trail.
        </p>
        <div className="flex items-center gap-3">
          <Button variant="ghost" onClick={reload} busy={busy === 'issue'} disabled={!enabled || Boolean(busy)}>
            Issue 10 units
          </Button>
          <Button variant="primary" onClick={redeem} busy={busy === 'redeem'} disabled={!canRedeem}>
            Redeem at maturity
          </Button>
        </div>
      </div>

      {result && (
        <div className="mt-3">
          <Callout
            tone="pos"
            title={`Redeemed — ${formatQty(result.unitsBurned, 0)} units burned, ${formatCash(result.principalPaid, cashDecimals)} paid`}
          >
            <span className="inline-flex flex-wrap items-center gap-3">
              {result.cashTxHash && (
                <Addr value={result.cashTxHash} kind="hash" href={hashscan.tx(result.cashTxHash)} />
              )}
              <Addr value={result.redeemTxHash} kind="hash" href={hashscan.tx(result.redeemTxHash)} />
            </span>
          </Callout>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Callout tone="neg" title="The redemption did not go through">{error}</Callout>
        </div>
      )}
    </Panel>
  );
}

/** Human age for a span of seconds. The oracle bound is in hours, not days. */
function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const hours = seconds / 3600;
  if (hours < 48) return `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
  return `${Math.floor(hours / 24)}d`;
}

// ------------------------------------------------------------------- schedule

function AssetPicker({
  assets, selected, onSelect,
}: {
  assets: Asset[] | undefined;
  selected: Asset | null;
  onSelect: (token: string) => void;
}) {
  return (
    <Panel title="Issued assets" bodyClassName="p-0">
      {!assets?.length ? (
        <div className="p-4"><Empty>No assets issued yet.</Empty></div>
      ) : (
        <ul>
          {assets.map((a) => (
            <li key={a.token} className="border-b border-line/60 last:border-0">
              <button
                onClick={() => onSelect(a.token)}
                className={cn(
                  'w-full px-4 py-3 text-left transition-[transform,background-color] duration-200 hover:translate-x-0.5 focusable',
                  selected?.token === a.token ? 'bg-raised' : 'hover:bg-wineWash'
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm text-txt">{a.symbol}</span>
                  <span className="text-2xs text-dim uppercase tracking-wider">{a.assetClass}</span>
                </div>
                <div className="mt-0.5 text-2xs text-muted">{a.name}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-2xs text-dim">
                  {a.isin && <span className="font-mono">{a.isin}</span>}
                  {a.maturity != null && <span>matures {formatDate(a.maturity)}</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function CouponSchedule({ asset, cashDecimals }: { asset: Asset | null; cashDecimals: number }) {
  const coupons = asset?.coupons ?? [];

  return (
    <Panel
      title="Lifecycle schedule"
      subtitle={
        asset?.assetClass === 'EQUITY'
          ? 'Equity pays dividends rather than coupons.'
          : 'Scheduled on-chain by the contract itself, via HIP-1215.'
      }
      bodyClassName={coupons.length ? 'p-0' : 'p-4'}
    >
      {!coupons.length ? (
        <Empty>
          {asset ? 'No scheduled events for this asset.' : 'Select an asset to see its schedule.'}
        </Empty>
      ) : (
        <ul>
          {coupons.map((c, i) => {
            const executed = c.status === 'EXECUTED';
            return (
              <li
                key={`${c.date}-${i}`}
                className="px-4 py-3 border-b border-line/60 last:border-0 flex items-center gap-3"
              >
                <span
                  className={cn(
                    'h-2 w-2 rounded-full shrink-0',
                    executed ? 'bg-pos' : 'bg-held'
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-txt num">{formatDate(c.date)}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-dim">
                    <span className={executed ? 'text-pos' : 'text-held'}>
                      {executed ? 'Executed' : 'Scheduled'}
                    </span>
                    {c.scheduleId && (
                      <HashScanLink href={hashscan.schedule(c.scheduleId)}>
                        schedule {c.scheduleId}
                      </HashScanLink>
                    )}
                    {c.txHash && (
                      <HashScanLink href={hashscan.tx(c.txHash)}>transaction</HashScanLink>
                    )}
                  </div>
                </div>
                {c.amount && (
                  <span className="num text-xs text-muted shrink-0">
                    {formatCash(c.amount, cashDecimals)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {asset?.couponRate != null && (
        <div className="px-4 py-2.5 border-t border-line flex items-center justify-between text-2xs">
          <span className="label">coupon</span>
          <span className="text-muted">
            {formatPct(asset.couponRate)}
            {asset.couponFrequency ? ` · ${asset.couponFrequency}× a year` : ''}
          </span>
        </div>
      )}
    </Panel>
  );
}
