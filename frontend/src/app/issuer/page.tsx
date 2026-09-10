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
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { Panel, Empty } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Callout } from '@/components/ui/Field';
import { Addr, HashScanLink } from '@/components/ui/Addr';
import { PageHead } from '@/components/layout/PageHead';
import { Shell } from '@/components/layout/Shell';
import { useHealth, useAssets, qk } from '@/hooks/useApi';
import { useRole } from '@/hooks/useRole';
import { api, errorCopy, type Asset, type Health } from '@/lib/api';
import { hashscan } from '@/lib/hashscan';
import { formatDate, formatCash, formatPct, formatQty } from '@/lib/format';
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
        </div>

        <div className="lg:col-span-2 space-y-4">
          <AssetPicker assets={assets} selected={asset} onSelect={(t) => setAssetToken(t)} />
          <CouponSchedule asset={asset} cashDecimals={health?.cashDecimals ?? 6} />
        </div>
      </div>
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
                  'w-full text-left px-4 py-3 transition-colors focusable',
                  selected?.token === a.token ? 'bg-raised' : 'hover:bg-raised/60'
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
