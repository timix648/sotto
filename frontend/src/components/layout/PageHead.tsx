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
        <h1 className="text-base font-medium text-txt">{title}</h1>
        <p className="mt-1 text-sm text-muted leading-relaxed">{blurb}</p>
      </div>
      <div className="text-right shrink-0">
        <div className="label">acting as</div>
        <Addr value={address} href={hashscan.account(address)} />
        <div className="text-2xs text-dim mt-0.5">
          {isWallet ? 'connected wallet' : 'demo party — connect a wallet to sign yourself'}
        </div>
      </div>
    </div>
  );
}
