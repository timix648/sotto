'use client';

// The header carries state, not navigation between identities.
//
// Choosing who you are is a deliberate act that now lives on its own page
// (/enter). What stays here is the consequence of that choice: which desk you
// are at, what you hold, and whether the data is live. A judge still sees which
// hat is being worn without anyone explaining it — B0's requirement — but the
// switch itself is no longer a control sitting on every screen.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useHealth, useWsStatus } from '@/hooks/useApi';
import { useRole, ROLES } from '@/hooks/useRole';
import { WalletButton } from './WalletButton';
import { ThemeToggle } from './ThemeToggle';
import { BalanceChip } from './BalanceChip';
import { Lamp } from '@/components/ui/Status';
import { hashscan } from '@/lib/hashscan';
import { API_BASE } from '@/lib/config';
import { cn } from '@/lib/cn';

const NAV = [
  { href: '/', label: 'Venue', exact: true },
  { href: '/rulebook', label: 'Rulebook' },
  { href: '/audit', label: 'Audit trail' },
];

export function Header() {
  const { role, isWallet, demoMode } = useRole();
  const { data: health, isError } = useHealth();
  const ws = useWsStatus();
  const pathname = usePathname();

  const desk = ROLES.find((r) => r.id === role);
  const atEntry = pathname === '/enter';
  const atHome = pathname === '/';

  return (
    <header className="sticky top-0 z-40 border-b-2 border-line bg-ground/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-7 px-4 sm:px-6">
        <Link href="/" className="flex shrink-0 items-baseline gap-2.5 focusable rounded">
          <span className="text-lg font-bold tracking-[0.2em] text-txt">SOTTO</span>
          <span className="hidden text-xs tracking-wide text-dim md:inline">RFQ BLOCK VENUE</span>
        </Link>

        <nav className="hidden items-center gap-5 sm:flex">
          {NAV.map((n) => {
            const active = n.exact ? pathname === n.href : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  'text-sm font-medium transition-colors focusable rounded',
                  active ? 'text-txt' : 'text-muted hover:text-wine'
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2.5">
          <span className="hidden items-center gap-3 text-xs text-dim xl:flex">
            {!atHome && (
              <Lamp
                tone={ws === 'open' ? 'pos' : ws === 'connecting' ? 'held' : 'neg'}
                label={ws === 'open' ? 'live' : ws === 'connecting' ? 'connecting' : 'offline'}
                title={`WebSocket ${ws} · ${API_BASE}`}
              />
            )}
            {health?.topicId && (
              <a
                href={hashscan.topic(health.topicId) ?? '#'}
                target="_blank"
                rel="noreferrer"
                className="font-mono hover:text-txt focusable rounded"
                title="HCS audit topic"
              >
                HCS {health.topicId}
              </a>
            )}
          </span>

          {!atHome && <BalanceChip />}

          {/* Which desk you are at. Pressing it returns you to the entry page —
              it reports a state, it does not switch identity in place. */}
          {!atEntry && (
            <Link
              href="/enter"
              title="Change desk"
              className="hidden items-center gap-2 rounded-lg border border-line px-2.5 py-1.5
                         text-xs text-muted transition-colors hover:border-wine hover:text-wine
                         focusable lg:flex"
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  isWallet ? 'bg-pos' : demoMode ? 'bg-held' : 'bg-dim'
                )}
                aria-hidden
              />
              {isWallet
                ? desk?.label ?? 'Wallet desk'
                : demoMode
                  ? `Demo ${desk?.label?.toLowerCase() ?? 'desk'}`
                  : 'Choose desk'}
            </Link>
          )}

          <ThemeToggle />
          {!atHome && !atEntry && <WalletButton />}
        </div>
      </div>

      {health?.mock === true && <FixtureStrip />}
      {isError && (
        <div className="border-t border-neg/30 bg-negWash px-4 py-1.5 text-center text-2xs text-neg">
          Cannot reach the Sotto API at <span className="font-mono">{API_BASE}</span> — start it, or
          point <span className="font-mono">NEXT_PUBLIC_API_BASE</span> somewhere it is running.
        </div>
      )}
    </header>
  );
}

/** START-HERE §4: the mock once shadowed the live API on a shared port and we
 *  filmed fixtures believing they were the chain. Impossible to miss now. */
function FixtureStrip() {
  return (
    <div className="border-t border-held/30 bg-heldWash px-4 py-1.5 text-center text-2xs tracking-wide text-held">
      <span className="font-semibold">FIXTURE DATA</span> — this is the mock server on{' '}
      <span className="font-mono">{API_BASE}</span>, not Hedera testnet. Point{' '}
      <span className="font-mono">NEXT_PUBLIC_API_BASE</span> at the live API (
      <span className="font-mono">:4000</span>) before recording.
    </div>
  );
}
