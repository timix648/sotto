'use client';

// The home page. Three screens, not one pager:
//
//   1. the claim        — what the venue does that nothing else does
//   2. the mechanism    — how it does it, in three moves
//   3. the proof        — that it is deployed, with the addresses to check
//
// Sections fade up as they enter the viewport, and the hero carries a live
// demonstration of the sealed → revealed → awarded cycle rather than a
// screenshot of one. Content is never gated behind an animation: everything is
// visible if JavaScript never runs.
import Link from 'next/link';
import { Shell } from '@/components/layout/Shell';
import { Addr, HashScanLink } from '@/components/ui/Addr';
import { SealedDemo } from '@/components/home/SealedDemo';
import { RfqList } from '@/components/RfqList';
import { useHealth, useRfqs, useAssets } from '@/hooks/useApi';
import { useReveal } from '@/hooks/useReveal';
import { hashscan } from '@/lib/hashscan';
import { formatDate, formatPct, formatPrice } from '@/lib/format';

export default function HomePage() {
  useReveal();

  const { data: health } = useHealth();
  const { data: rfqs } = useRfqs();
  const { data: assets } = useAssets();

  const live = rfqs?.filter((r) => r.status === 'OPEN' || r.status === 'REVEALING') ?? [];
  const cashDecimals = health?.cashDecimals ?? 6;

  return (
    <>
      {/* ---------------------------------------------------------- 1. claim */}
      <section className="border-b border-line">
        <Shell className="py-14 sm:py-20">
          <div className="grid items-center gap-10 lg:grid-cols-[1.05fr_1fr] lg:gap-14">
            <div className="reveal">
              <p className="label flex items-center gap-2">
                <span className="h-[5px] w-6 bg-held" aria-hidden />
                A sealed venue on Hedera
              </p>
              <h1 className="mt-4 text-4xl font-bold leading-[1.08] tracking-tight text-txt sm:text-5xl">
                Dealers compete
                <br />
                without ever seeing
                <br />
                <span className="text-neg">a rival&apos;s price.</span>
              </h1>
              <p className="mt-5 max-w-xl text-base leading-7 text-muted sm:text-lg sm:leading-8">
                Sotto is a request-for-quote venue for block trades in tokenised securities. A
                bondholder puts size up for bid; dealers quote under commit–reveal, so nobody can
                last-look off a competitor. The winning trade settles as one atomic
                delivery-versus-payment transaction — security leg and cash leg, both or neither.
              </p>

              <div className="mt-7 flex flex-wrap gap-3">
                <Link
                  href="/enter"
                  className="rounded-lg border border-brand bg-brand px-4 py-2.5 text-sm font-semibold text-brandTxt
                             transition-opacity hover:opacity-90 focusable"
                >
                  Enter the venue →
                </Link>
                <Link
                  href="/rulebook"
                  className="rounded-lg border border-line px-4 py-2.5 text-sm font-medium text-txt
                             transition-colors hover:border-lineBright focusable"
                >
                  Read the rulebook
                </Link>
              </div>
            </div>

            <div className="reveal" style={{ transitionDelay: '120ms' }}>
              <SealedDemo />
            </div>
          </div>
        </Shell>
      </section>

      {/* ------------------------------------------------------ 2. mechanism */}
      <section className="border-b border-line bg-raised/40">
        <Shell className="py-14 sm:py-20">
          <div className="reveal max-w-2xl">
            <p className="label">The mechanism</p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-txt sm:text-3xl">
              Three moves, and nothing to trust in between.
            </h2>
          </div>

          <div className="mt-10 grid border-y border-line md:grid-cols-3">
            {[
              {
                n: '01',
                title: 'Escrow, without giving up the asset',
                body: 'The seller places an ATS hold naming the settlement contract as escrow agent. Available drops, Held rises, and Total does not move — the block never leaves the seller’s account, and coupons keep accruing on all of it.',
                foot: 'If nothing is awarded, anyone may reclaim the hold directly from ATS.',
              },
              {
                n: '02',
                title: 'Quote blind, reveal on consensus',
                body: 'Dealers submit keccak256(price, quantity, nonce, dealer). Only the hash reaches the ledger. The window closes on a Hedera consensus timestamp rather than our clock, and every reveal is recomputed against its commit.',
                foot: 'A price that can be changed after the window closes is not a sealed quote.',
              },
              {
                n: '03',
                title: 'Settle both legs, or neither',
                body: 'Both parties sign an EIP-712 trade. One transaction moves the cash and executes the hold. ATS runs compliance inside the delivery — so a revoked KYC rolls back the payment with it.',
                foot: 'That is the difference between a settlement system and a token transfer.',
              },
            ].map((step, i) => (
              <article
                key={step.n}
                className={`reveal flex flex-col py-7 md:px-7 ${i > 0 ? 'border-t border-line md:border-l md:border-t-0' : ''}`}
                style={{ transitionDelay: `${i * 110}ms` }}
              >
                <span className="font-mono text-2xs font-semibold text-held">{step.n}</span>
                <h3 className="mt-3 text-lg font-semibold leading-snug text-txt">{step.title}</h3>
                <p className="mt-3 flex-1 text-[15px] leading-7 text-muted">{step.body}</p>
                <p className="mt-5 border-t border-line pt-4 text-[13px] leading-6 text-dim">
                  {step.foot}
                </p>
              </article>
            ))}
          </div>

          <div className="reveal mt-7 flex flex-wrap items-center gap-x-8 gap-y-4 border-b border-line pb-7">
            {[
              ['Commit → reveal', 'prices sealed until the window closes on consensus'],
              ['Atomic DvP', 'both legs move in one transaction, or neither does'],
              ['One HCS topic', 'every event ordered by the ledger, not by our clock'],
            ].map(([t, d]) => (
              <div key={t} className="min-w-[13rem] flex-1">
                <div className="text-sm font-semibold text-txt">{t}</div>
                <div className="mt-1 text-[13px] leading-relaxed text-dim">{d}</div>
              </div>
            ))}
          </div>
        </Shell>
      </section>

      {/* ---------------------------------------------------------- 3. proof */}
      <section>
        <Shell className="py-14 sm:py-20">
          <div className="reveal max-w-2xl">
            <p className="label">Deployed on Hedera testnet</p>
            <h2 className="mt-3 text-2xl font-bold tracking-tight text-txt sm:text-3xl">
              Every claim on this site links to the ledger.
            </h2>
            <p className="mt-3 text-base leading-7 text-muted">
              Nothing here is mocked and nothing was minted for convenience: the bond is issued
              from Hedera&apos;s own ATS factory, and the cash leg settles in real Circle USDC.
            </p>
          </div>

          <div className="mt-8 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <div className="reveal space-y-4">
              <RfqList
                rfqs={rfqs && live}
                title="Live requests"
                subtitle="Open for quotes, or in the reveal window"
                emptyMessage="No live requests. A seller opens one from the seller desk."
              />

              {assets && assets.length > 0 && (
                <div className="rounded-xl border border-line bg-panel">
                  <header className="border-b border-line px-4 py-3">
                    <h3 className="text-sm font-semibold text-txt">Listed assets</h3>
                    <p className="mt-0.5 text-2xs text-dim">
                      Live instruments reported by the venue API
                    </p>
                  </header>
                  <ul>
                    {assets.map((a) => (
                      <li key={a.token} className="border-b border-line/60 px-4 py-3 last:border-0">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="text-sm font-medium text-txt">{a.symbol}</span>
                          <span className="text-2xs uppercase tracking-wider text-dim">
                            {a.assetClass ?? '—'}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-2xs text-muted">
                          <span>{a.name}</span>
                          {a.couponRate != null && <span>coupon {formatPct(a.couponRate)}</span>}
                          {a.maturity != null && <span>matures {formatDate(a.maturity)}</span>}
                          {a.nav && (
                            <span className="num">NAV {formatPrice(a.nav, cashDecimals)}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="reveal rounded-xl border border-line bg-panel" style={{ transitionDelay: '110ms' }}>
              <header className="border-b border-line px-4 py-3">
                <h3 className="text-sm font-semibold text-txt">Contracts</h3>
                <p className="mt-0.5 text-2xs text-dim">
                  {health?.network ?? 'reading /api/health…'}
                </p>
              </header>
              <dl className="text-xs">
                <AddrRow label="Settlement" value={health?.settlementAddress} />
                <AddrRow label="Bond" value={health?.bondAddress} />
                <AddrRow label="Equity" value={health?.equityAddress} />
                <AddrRow label="NAV oracle" value={health?.navOracleAddress} />
                <AddrRow label="Dealer bond" value={health?.dealerBondAddress} />
                <AddrRow label="Coupon scheduler" value={health?.schedulerAddress} />
                <AddrRow label="Cash (USDC)" value={health?.cashToken} />
                <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5">
                  <dt className="label">HCS audit topic</dt>
                  <dd>
                    {health?.topicId ? (
                      <HashScanLink href={hashscan.topic(health.topicId)}>
                        <span className="font-mono">{health.topicId}</span>
                      </HashScanLink>
                    ) : (
                      <span className="text-dim">—</span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        </Shell>
      </section>
    </>
  );
}

function AddrRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 first:border-t-0">
      <dt className="label">{label}</dt>
      <dd>
        <Addr value={value} href={hashscan.contract(value)} />
      </dd>
    </div>
  );
}
