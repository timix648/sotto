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
import { useAppKitAccount } from '@reown/appkit/react';
import { useAccount } from 'wagmi';
import { Shell } from '@/components/layout/Shell';
import { Addr } from '@/components/ui/Addr';
import { WalletButton } from '@/components/layout/WalletButton';
import { useRole, ROLES, type Role } from '@/hooks/useRole';
import { useSettlementPath } from '@/hooks/useSettlementPath';
import { useHealth } from '@/hooks/useApi';
import { hashscan } from '@/lib/hashscan';
import { cn } from '@/lib/cn';
import { nativeWalletNamespace } from '@/lib/appkit';

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
  const { path, togglePath } = useSettlementPath();
  const { data: health } = useHealth();
  const { isConnected: evmConnected } = useAccount();
  const native = useAppKitAccount({ namespace: nativeWalletNamespace });
  // Path B needs BOTH: the EVM session signs the EIP-712 Trade, the native
  // session signs the buyer's own cash leg. One without the other cannot settle.
  const pathConnected = path === 'A' ? evmConnected : evmConnected && native.isConnected;
  const walletActsAsDesk = path === 'A' && evmConnected;
  const switchTitle =
    path === 'A'
      ? 'Path A settles through a USDC allowance. Click for the Hedera-native batch route, where no allowance is granted at all.'
      : 'Path B settles as a HIP-551 atomic batch and needs a HIP-820 wallet alongside the EVM one. Click to return to the allowance route.';

  const enter = (r: Role) => {
    setRole(r);
    // Demo mode is about whether a real wallet is driving, not about which
    // settlement route is selected. Path B used to force it on, which left the
    // dealer connected correctly and the settle button disabled anyway, because
    // the portal gates signing on isWallet. Both paths sign the EIP-712 Trade
    // with the EVM wallet; Path B adds a native signature on top.
    setDemoMode(!evmConnected);
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

      <section className="mt-7 flex flex-col gap-4 rounded-xl border-2 border-line bg-panel p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-2xl">
          <p className="label">Settlement route</p>
          <h2 className="mt-1.5 text-lg font-semibold text-txt">
            {path === 'A' ? 'Path A · EVM allowance' : 'Path B · Hedera atomic batch'}
          </h2>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">
            {path === 'A'
              ? 'Broad wallet compatibility. The buyer approves exact USDC and anyone can submit the signed atomic settlement.'
              : 'No allowance anywhere. The buyer signs a native HTS transfer of their own cash, the venue signs delivery, and the network guarantees both legs or neither. Needs a HIP-820 wallet as well as the EVM one — HashPack gives you both.'}
          </p>
        </div>

        <div className="group relative shrink-0 self-start sm:self-auto">
          <button
            type="button"
            onClick={togglePath}
            title={switchTitle}
            aria-describedby="settlement-path-tip"
            className="rounded-lg border-2 border-wine bg-wineWash px-4 py-2.5 text-left text-sm font-semibold text-wine transition-[transform,background-color,color] duration-200 hover:-translate-y-0.5 hover:bg-wine hover:text-white focusable"
          >
            Switch to Path {path === 'A' ? 'B' : 'A'}
            <span className="ml-2" aria-hidden>↔</span>
          </button>
          <span
            id="settlement-path-tip"
            role="tooltip"
            className="pointer-events-none absolute right-0 top-full z-20 mt-2 hidden w-72 rounded-lg border border-line bg-panel p-3 text-xs font-normal leading-relaxed text-muted shadow-panel group-hover:block group-focus-within:block"
          >
            {switchTitle}
          </span>
        </div>
      </section>

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
                'group flex flex-col rounded-xl border-2 bg-panel p-5 text-left transition-all duration-200 focusable',
                'hover:-translate-y-1 hover:border-wine hover:shadow-panel',
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
                ) : <span className="text-xs text-dim">{walletActsAsDesk ? 'wallet desk' : pathConnected ? 'native wallet ready' : 'demo available'}</span>}
                <span className="text-xs font-medium text-txt transition-transform group-hover:translate-x-0.5">
                  {walletActsAsDesk ? 'Enter →' : 'Open demo →'}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      <section className="mt-8 border-y-2 border-line py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h2 className="text-base font-semibold text-txt">
              {pathConnected
                ? path === 'A' ? 'EVM wallet connected' : 'Hedera wallet connected'
                : demoMode ? 'Demo mode is active' : 'Connect or preview'}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted">
              {pathConnected
                ? path === 'A'
                  ? 'Path A contract actions and trade approvals are signed by your EVM wallet.'
                  : 'The native Hedera session is connected. This confirms wallet compatibility; it does not yet sign or submit an RFQ batch from the browser.'
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
