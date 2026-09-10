import Link from 'next/link';

export function Footer() {
  return (
    <footer className="mt-16 border-t-2 border-line">
      <div className="mx-auto w-full max-w-[1400px] px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-md">
            <div className="text-sm font-semibold tracking-[0.16em] text-txt">SOTTO</div>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              Sotto settles ATS-issued securities against real Circle USDC on Hedera testnet.
              Every figure on this site is read from the venue API; every on-chain claim links
              to HashScan.
            </p>
          </div>

          <nav className="flex flex-wrap gap-x-8 gap-y-2 text-xs">
            <Link href="/rulebook" className="text-muted hover:text-wine focusable rounded">
              Rulebook
            </Link>
            <Link href="/audit" className="text-muted hover:text-wine focusable rounded">
              Audit trail
            </Link>
            <Link href="/enter" className="text-muted hover:text-wine focusable rounded">
              Enter the venue
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
