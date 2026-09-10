'use client';

// The role model. BLUEPRINT B0: "Role switcher in the header — Issuer / Seller /
// Dealer — driven by connected address, with a demo override. Judges watch a
// 5-minute video; they need to see which hat you're wearing."
//
// Two MECHANICS §4.10 failures shape this:
//   - "Sign-out that bounced straight back in, because it cleared the app role
//     but left the wallet connected." So the role and the wallet are separate
//     pieces of state, and clearing one never implies the other.
//   - "Roles need to be visible at a glance." So the role is always explicit in
//     the header, never inferred silently.
//
// The venue is fully usable with NO wallet connected: it then acts as the demo
// party for the chosen role, exactly as the backend scripts do today. Connecting
// a wallet upgrades signing from a backend key to a real signature; it is not a
// precondition for looking around.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { useAccount } from 'wagmi';
import { useHealth } from './useApi';

export type Role = 'issuer' | 'seller' | 'dealer';

export const ROLES: { id: Role; label: string; blurb: string }[] = [
  { id: 'issuer', label: 'Issuer', blurb: 'Issues the asset and controls compliance' },
  { id: 'seller', label: 'Seller', blurb: 'Holds the block and puts it up for bid' },
  { id: 'dealer', label: 'Dealer', blurb: 'Quotes under commit–reveal and buys' },
];

const STORAGE_KEY = 'sotto.role';

interface RoleContextValue {
  role: Role;
  setRole: (r: Role) => void;
  /** Address we are acting as: the connected wallet, else the demo party. */
  address: string | null;
  /** True when `address` came from a real wallet rather than the demo fixture. */
  isWallet: boolean;
  /** The demo party address for the current role, when the API reports one. */
  demoAddress: string | null;
  /** Set when a connected wallet matches a known demo party. */
  matchedRole: Role | null;
}

const RoleContext = createContext<RoleContextValue | null>(null);

export function RoleProvider({ children }: { children: ReactNode }) {
  const { address: wallet, isConnected } = useAccount();
  const { data: health } = useHealth();
  const pathname = usePathname();
  const [role, setRoleState] = useState<Role>('seller');
  const [touched, setTouched] = useState(false);

  // Restore the last role. Never restores a wallet connection — see above.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved === 'issuer' || saved === 'seller' || saved === 'dealer') {
        setRoleState(saved);
        setTouched(true);
      }
    } catch { /* private mode; the default role is fine */ }
  }, []);

  const accounts = health?.accounts;

  const matchedRole = useMemo<Role | null>(() => {
    if (!isConnected || !wallet || !accounts) return null;
    const w = wallet.toLowerCase();
    if (accounts.issuer?.toLowerCase() === w) return 'issuer';
    if (accounts.seller?.toLowerCase() === w) return 'seller';
    if (accounts.dealer?.toLowerCase() === w) return 'dealer';
    return null;
  }, [isConnected, wallet, accounts]);

  // The URL is the source of truth for which desk you are at. Landing on
  // /seller with the role still set to "dealer" showed the seller's screen with
  // the dealer's balances — a mismatch that reads as a data bug and is exactly
  // the kind of thing MECHANICS §4.10 lists (a holdings panel showing assets the
  // party did not own). The route decides; /enter simply navigates.
  useEffect(() => {
    const fromPath = ROLES.find((r) => pathname.startsWith(`/${r.id}`))?.id;
    if (fromPath && fromPath !== role) {
      setRoleState(fromPath);
      try { window.localStorage.setItem(STORAGE_KEY, fromPath); } catch { /* ignore */ }
    }
  }, [pathname, role]);

  // Otherwise derive from the connected address, but never override a choice.
  useEffect(() => {
    if (matchedRole && !touched) setRoleState(matchedRole);
  }, [matchedRole, touched]);

  const setRole = useCallback((r: Role) => {
    setRoleState(r);
    setTouched(true);
    try { window.localStorage.setItem(STORAGE_KEY, r); } catch { /* ignore */ }
  }, []);

  const demoAddress = accounts?.[role] ?? null;
  const address = (isConnected && wallet ? wallet : demoAddress) ?? null;

  const value = useMemo<RoleContextValue>(
    () => ({ role, setRole, address, isWallet: Boolean(isConnected && wallet), demoAddress, matchedRole }),
    [role, setRole, address, isConnected, wallet, demoAddress, matchedRole]
  );

  return <RoleContext.Provider value={value}>{children}</RoleContext.Provider>;
}

export function useRole(): RoleContextValue {
  const ctx = useContext(RoleContext);
  if (!ctx) throw new Error('useRole must be used inside <RoleProvider>');
  return ctx;
}
