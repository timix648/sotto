'use client';

import { Addr } from '@/components/ui/Addr';
import { hashscan } from '@/lib/hashscan';

/** Title, one sentence of orientation, and who you are acting as. Every portal
 *  opens with this so the role is legible at a glance on camera (B0). */
export function PageHead({
  title, blurb, address, isWallet,
}: {
  title: string;
  blurb: string;
  address: string | null;
  isWallet: boolean;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight text-txt">{title}</h1>
        <p className="mt-2 text-base leading-relaxed text-muted">{blurb}</p>
      </div>
      <div className="text-right shrink-0">
        <div className="label">{address ? 'acting as' : 'public view'}</div>
        {address ? (
          <Addr value={address} href={hashscan.account(address)} />
        ) : (
          <div className="mt-1 text-sm font-medium text-txt">No account selected</div>
        )}
        <div className="mt-1 text-xs text-dim">
          {address
            ? isWallet ? 'connected wallet' : 'labelled testnet demo'
            : 'Choose a demo desk or connect a wallet'}
        </div>
      </div>
    </div>
  );
}
