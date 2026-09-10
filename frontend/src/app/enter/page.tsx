'use client';

// The entry terminal.
//
// Choosing a desk used to be three tabs sitting on every screen. It is a
// deliberate act — you are declaring which side of a trade you are on — so it
// gets a page, and the header afterwards only reports the consequence.
//
// The venue is usable with no wallet: pick a desk and you act as that demo
// party, which is how every settlement on testnet so far was signed. Connecting
// a wallet upgrades signing to a real EIP-712 signature. It is never a gate — a
// judge should be able to walk the whole venue without one.
import { useRouter } from 'next/navigation';
import { useAccount } from 'wagmi';
import { Shell } from '@/components/layout/Shell';
import { Addr } from '@/components/ui/Addr';
import { WalletButton } from '@/components/layout/WalletButton';
import { useRole, ROLES, type Role } from '@/hooks/useRole';
import { useHealth } from '@/hooks/useApi';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';

const DETAIL: Record<Role, { does: string; here: string[] }> = {
  issuer: {
    does: 'Brings the asset into existence and holds the compliance controls.',
    here: [
      'Issue units of the deployed ATS security',
      'Grant and revoke KYC — enforced by ATS at the transfer itself',
      'Watch the coupon schedule the contract wrote on-chain',
    ],
  },
  seller: {
    does: 'Owns the block and wants to move size without moving the market.',
    here: [
      'Escrow a block with an ATS hold — total never leaves your account',
      'Take sealed quotes from competing dealers',
      'Award the best firm price and sign the trade',
    ],
  },
  dealer: {
    does: 'Prices the block and buys it, competing blind against other dealers.',
    here: [
      'Commit a sealed price nobody — including the venue — can read',
      'Reveal it when the window closes, and have it verified against your commit',
      'Approve the cash and settle both legs in one transaction',
    ],
  },
};

export default function EnterPage() {
  const router = useRouter();
  const { role, setRole, matchedRole, demoMode, setDemoMode } = useRole();
  const { data: health } = useHealth();
  const { isConnected } = useAccount();

  const enter = (r: Role) => {
    setRole(r);
    setDemoMode(!isConnected);
    router.push(`/${r}`);
  };

  return (
    <Shell className="max-w-[1100px] py-10 sm:py-16">
      <div className="max-w-2xl">
        <p className="label">Enter the venue</p>
        <h1 className="mt-3 text-3xl font-bold leading-tight tracking-tight text-txt sm:text-4xl">
          Which side of the trade are you on?
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          Sotto is a request-for-quote venue: one seller, several dealers, and an issuer who can
          stop a settlement at the transfer. Pick a desk to see the venue from that side. You can
          change desk at any time from the header.
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {ROLES.map((r) => {
          const d = DETAIL[r.id];
          const isCurrent = role === r.id;
          const isMatched = matchedRole === r.id;
          const demoAddress = health?.accounts?.[r.id];

          return (
            <button
              key={r.id}
              onClick={() => enter(r.id)}
              className={cn(
                'group flex flex-col rounded-xl border bg-panel p-5 text-left transition-all focusable',
                'hover:-translate-y-0.5 hover:border-lineBright hover:shadow-panel',
                isCurrent ? 'border-held/50' : 'border-line'
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-lg font-semibold text-txt">{r.label}</h2>
                {isMatched ? (
                  <span className="rounded border border-pos/40 px-1.5 py-0.5 text-2xs text-pos">
                    your wallet
                  </span>
                ) : isCurrent && demoMode ? (
                  <span className="rounded border border-held/40 px-1.5 py-0.5 text-2xs text-held">
                    demo active
                  </span>
                ) : null}
              </div>

              <p className="mt-1.5 text-xs leading-relaxed text-muted">{d.does}</p>

              <ul className="mt-4 space-y-2 border-t border-line pt-4">
                {d.here.map((item) => (
                  <li key={item} className="flex gap-2 text-xs leading-relaxed text-muted">
                    <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-dim" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>

              <div className="mt-4 flex items-center justify-between gap-2 border-t border-line pt-3">
                {demoAddress && demoMode && isCurrent ? (
                  <span className="flex items-center gap-1.5">
                    <span className="label">demo party</span>
                    <span className="font-mono text-2xs text-dim">
                      {demoAddress.slice(0, 6)}…{demoAddress.slice(-4)}
                    </span>
                  </span>
                ) : <span className="text-xs text-dim">{isConnected ? 'wallet desk' : 'demo available'}</span>}
                <span className="text-xs font-medium text-txt transition-transform group-hover:translate-x-0.5">
                  {isConnected ? 'Enter →' : 'Open demo →'}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <section className="mt-8 border-y border-line py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h2 className="text-base font-semibold text-txt">
              {isConnected ? 'Wallet connected' : demoMode ? 'Demo mode is active' : 'Connect or preview'}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              {isConnected
                ? 'Trading actions are signed by your wallet. The venue never substitutes a demo account while you are connected.'
                : demoMode
                  ? 'You explicitly opened a funded testnet demo desk. Demo balances are labelled and trading signatures still require a wallet.'
                  : 'Public browsing shows no account or balance. Choose a desk above to open its labelled testnet demo, or connect a wallet to act as yourself.'}
            </p>
          </div>
          <WalletButton />
        </div>

        {health?.settlementAddress && (
          <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-4 text-xs">
            <span className="flex items-center gap-1.5">
              <span className="label">settles through</span>
              <Addr
                value={health.settlementAddress}
                href={hashscan.contract(health.settlementAddress)}
              />
            </span>
            <span className="flex items-center gap-1.5">
              <span className="label">network</span>
              <span className="text-muted">{health.network}</span>
            </span>
          </div>
        )}
      </section>
    </Shell>
  );
}
