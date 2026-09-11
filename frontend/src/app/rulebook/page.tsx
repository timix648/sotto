'use client';

// The rulebook.
//
// Every explanation the venue needs lives here rather than on the working
// screens. A trading screen should carry numbers and controls; the moment it
// starts teaching, it stops being usable at the speed the job requires. An
// exchange publishes a rulebook for exactly this reason, and this is ours.
//
// If a panel elsewhere needs a sentence of context, it gets one sentence and a
// link into this page — not a paragraph.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell } from '@/components/layout/Shell';
import { Addr } from '@/components/ui/Addr';
import { useHealth } from '@/hooks/useApi';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';

const SECTIONS = [
  { id: 'venue', number: '01', label: 'The venue' },
  { id: 'hold', number: '02', label: 'The hold' },
  { id: 'commit-reveal', number: '03', label: 'Commit–reveal' },
  { id: 'firmness', number: '04', label: 'Firmness' },
  { id: 'settlement', number: '05', label: 'Settlement' },
  { id: 'compliance', number: '06', label: 'Compliance' },
  { id: 'audit', number: '07', label: 'The audit trail' },
  { id: 'limits', number: '08', label: 'Current limits' },
  { id: 'glossary', number: '09', label: 'Glossary' },
];

export default function RulebookPage() {
  const { data: health } = useHealth();
  const [active, setActive] = useState('venue');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: '-20% 0px -70% 0px' }
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <Shell className="max-w-[1200px] py-8 sm:py-12">
      <header className="border-y-2 border-line py-8 sm:grid sm:grid-cols-[0.8fr_1.2fr] sm:gap-12 sm:py-12">
        <div>
          <p className="text-xs font-semibold tracking-[0.18em] text-held">SOTTO / VENUE RULEBOOK / 01</p>
          <h1 className="mt-4 max-w-md text-4xl font-semibold leading-[1.05] tracking-tight text-txt sm:text-5xl">
            Rules for a sealed block venue.
          </h1>
        </div>
        <div className="mt-8 sm:mt-0">
          <p className="max-w-2xl text-lg leading-8 text-muted">
            The operating rules, guarantees and limits of Sotto. This document is the source of
            truth; the trading desks stay focused on decisions and execution.
          </p>
          <dl className="mt-8 grid grid-cols-2 gap-x-8 gap-y-4 border-t border-line pt-5 text-sm sm:grid-cols-3">
            <div><dt className="label">Network</dt><dd className="mt-1 text-txt">Hedera testnet</dd></div>
            <div><dt className="label">Market</dt><dd className="mt-1 text-txt">ATS securities</dd></div>
            <div><dt className="label">Settlement</dt><dd className="mt-1 text-txt">Atomic DvP</dd></div>
          </dl>
        </div>
      </header>

      <div className="mt-12 grid gap-12 lg:grid-cols-[13rem_minmax(0,48rem)] lg:justify-center lg:gap-16">
        <nav className="mb-2 lg:sticky lg:top-24 lg:mb-0 lg:h-fit">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 lg:block lg:space-y-1">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className={cn(
                    'flex items-baseline gap-2 rounded py-1.5 text-sm transition-colors focusable lg:border-l lg:pl-3',
                    active === s.id
                      ? 'font-medium text-txt lg:border-held'
                      : 'text-muted hover:text-txt lg:border-line'
                  )}
                >
                  <span className="font-mono text-[11px] text-dim">{s.number}</span>
                  <span>{s.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0">
          <Section id="venue" title="The venue">
            <P>
              Asset Tokenization Studio lets an issuer mint a compliant bond. It does not let
              anyone trade one. Sotto is the missing half: a bondholder puts size up for bid,
              dealers compete under commit–reveal so nobody can last-look off a rival&apos;s
              price, and the winning trade settles as a single atomic delivery-versus-payment
              transaction — security leg and cash leg, both or neither.
            </P>
            <P>
              There are three parties. The <B>issuer</B> brings the asset into existence and holds
              the compliance controls. The <B>seller</B> owns a block and wants to move size. The{' '}
              <B>dealers</B> price that block, blind to each other.
            </P>
          </Section>

          <Section id="hold" title="The hold">
            <P>
              To offer a block, the seller calls{' '}
              <Code>createHoldByPartition</Code> naming the settlement contract as the{' '}
              <B>escrow agent</B>. This is an ATS primitive, not an escrow account the venue
              controls — the tokens never leave the seller&apos;s address.
            </P>
            <Steps
              items={[
                'Available drops, Held rises, and Total does not move. You still earn the coupon on the whole position.',
                'Only the escrow agent can execute the hold, and only to the address named at award.',
                'If nothing is awarded before the hold expires, anyone may call reclaimHoldByPartition directly on ATS. No venue code is involved.',
              ]}
            />
            <Note>
              A hold with an expiry of <Code>0</Code> never expires and could never be reclaimed,
              so the venue never writes one. The default is 48 hours.
            </Note>
          </Section>

          <Section id="commit-reveal" title="Commit–reveal">
            <P>
              Hedera&apos;s EVM is public, so the venue cannot hide a price the way a private
              ledger can. Instead of claiming a privacy it does not have, Sotto makes the price
              unreadable until it no longer matters.
            </P>
            <Steps
              ordered
              items={[
                'While the window is open, each dealer submits only keccak256(price, quantity, nonce, dealer). The venue receives a hash. Nobody — including us — can read a price.',
                'The window closes on a Hedera consensus timestamp, not on our server clock.',
                'Dealers reveal. Each reveal is recomputed against its commit and must match exactly. A dealer who cannot produce a matching reveal forfeits.',
                'The best valid revealed price wins. Ties break on the earliest consensus sequence number.',
              ]}
            />
            <Note>
              The preimage lives in the dealer&apos;s browser and nowhere else. Losing it means the
              quote cannot be revealed and is forfeit — that is a property of the mechanism, not a
              bug, and the dealer portal warns before it can happen.
            </Note>
          </Section>

          <Section id="firmness" title="Firmness">
            <P>
              A revealed price is firm for a stated period measured from its own consensus
              timestamp — not for as long as the seller feels like waiting. Once it lapses the
              quote cannot be awarded.
            </P>
            <P>
              Without that, a seller could sit on a revealed price and lift it after the market
              moved: a free option the dealer never agreed to write.
            </P>
          </Section>

          <Section id="settlement" title="Settlement">
            <P>
              Both parties sign an EIP-712 <Code>Trade</Code>. Settlement then, in one
              transaction: verify both signatures and consume nonces, check the hold, move the
              cash, execute the hold. Any failure reverts everything.
            </P>
            <div className="mt-7 grid gap-8 sm:grid-cols-2">
              <Card title="Path A — EVM allowance · live">
                The buyer grants an ERC-20 allowance; settlement pulls the cash and executes the
                hold in one EVM transaction. Atomicity comes from revert semantics. Anyone may
                relay a fully-signed trade — that is deliberate.
              </Card>
              <Card title="Path B — HIP-551 atomic batch">
                Each party signs only their own leg: a native HTS transfer for the cash, delivery
                as the last inner transaction. No allowance anywhere. Atomicity is provided by
                the network rather than by the contract.
              </Card>
            </div>
          </Section>

          <Section id="compliance" title="Compliance">
            <P>
              Compliance is enforced by ATS <B>at the transfer itself</B>, inside{' '}
              <Code>executeHoldByPartition</Code> — not bolted on by the venue. If the issuer has
              revoked the buyer&apos;s KYC, delivery is refused, and the payment that ran a line
              earlier is rolled back with it.
            </P>
            <P>
              This is why the venue can be permissionless without being unsafe. Sotto does not
              decide who may hold the asset; the asset does.
            </P>
          </Section>

          <Section id="audit" title="The audit trail">
            <P>
              Every stage of every request is written to one Hedera Consensus Service topic
              {health?.topicId ? <> — <Addr value={health.topicId} href={hashscan.topic(health.topicId)} /></> : null}.
              The sequence numbers are the integrity claim: a commit hash is timestamped by the
              network before any price behind it could be read.
            </P>
            <P>
              That makes the venue auditable without being transparent while the auction is live.
              You can check the ordering yourself on the{' '}
              <Link href="/audit" className="text-txt underline underline-offset-2">audit trail</Link>.
            </P>
          </Section>

          <Section id="limits" title="What we cannot do">
            <P>
              Stated plainly, because a settlement venue that only advertises its guarantees is
              not describing a settlement venue.
            </P>
            <Steps
              items={[
                'The browser currently executes Path A. Path B is proven through the repository scripts but still needs native Hedera wallet signing and batch assembly before it can be offered as an interface action.',
                'Dealer bonding, permissionless slashing and expired-hold reclaim exist at contract or script level; their browser controls are not yet wired.',
                'The reveal window is a real deadline. An unrevealed quote is forfeit and the venue cannot recover it.',
                'Testnet resets periodically; balances are re-funded from the Circle and Hedera faucets.',
                'There is no admin function anywhere in the settlement contract that can move user funds.',
              ]}
            />
          </Section>

          <Section id="glossary" title="Glossary">
            <dl className="divide-y divide-line border-y-2 border-line">
              {[
                ['Block', 'A large parcel of a security, traded in one negotiation rather than sliced into an order book.'],
                ['RFQ', 'Request for quote. The seller asks; dealers answer; the seller picks.'],
                ['Hold', 'An ATS escrow that reserves size in place, naming who may execute it and to whom.'],
                ['Partition', 'A named tranche within an ATS security. Balances and holds are per partition.'],
                ['DvP', 'Delivery versus payment. The security and the cash move together, or neither moves.'],
                ['Notional', 'Price × quantity — the total cash owed for the block.'],
                ['NAV band', 'A price range around the oracle mark. An award outside it is refused.'],
                ['HCS', 'Hedera Consensus Service. The ordered, timestamped log the venue writes to.'],
              ].map(([term, meaning]) => (
                <div key={term} className="grid gap-1 py-4 sm:grid-cols-[9rem_1fr] sm:gap-5">
                  <dt className="text-sm font-semibold text-txt">{term}</dt>
                  <dd className="text-[15px] leading-7 text-muted">{meaning}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <footer className="mt-16 border-t-2 border-line pt-5 text-sm text-dim">
            Sotto venue rulebook · testnet edition · rules reflected in the deployed contracts
            and the current venue implementation.
          </footer>
        </article>
      </div>
    </Shell>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  const number = SECTIONS.find((section) => section.id === id)?.number;
  return (
    <section id={id} className="scroll-mt-24 border-t border-line py-12 first:border-t-0 first:pt-0">
      <div className="grid gap-3 sm:grid-cols-[3rem_1fr] sm:gap-5">
        <span className="font-mono text-xs font-semibold text-held">{number}</span>
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-txt sm:text-3xl">{title}</h2>
          <div className="mt-5 space-y-5">{children}</div>
        </div>
      </div>
    </section>
  );
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="text-[17px] leading-8 text-muted">{children}</p>
);

const B = ({ children }: { children: React.ReactNode }) => (
  <strong className="font-semibold text-txt">{children}</strong>
);

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded-sm border border-line bg-raised/70 px-1.5 py-0.5 font-mono text-[13px] text-txt">{children}</code>
);

function Steps({ items, ordered }: { items: string[]; ordered?: boolean }) {
  const List = ordered ? 'ol' : 'ul';
  return (
    <List className="mt-4 space-y-3">
      {items.map((item, i) => (
        <li key={item} className="flex gap-3 text-[16px] leading-7 text-muted">
          <span
            className={cn(
              'mt-0.5 shrink-0 text-2xs font-semibold',
              ordered ? 'w-4 text-held' : 'w-1.5'
            )}
            aria-hidden
          >
            {ordered ? i + 1 : <span className="mt-1.5 block h-1 w-1 rounded-full bg-dim" />}
          </span>
          {item}
        </li>
      ))}
    </List>
  );
}

const Note = ({ children }: { children: React.ReactNode }) => (
  <p className="mt-5 border-l-2 border-held bg-heldWash/60 px-4 py-3 text-[15px] leading-7 text-held">
    {children}
  </p>
);

const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="border-t-2 border-txt/15 pt-4">
    <h3 className="text-base font-semibold text-txt">{title}</h3>
    <p className="mt-2 text-[15px] leading-7 text-muted">{children}</p>
  </div>
);
