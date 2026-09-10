'use client';

// The dealer's sealed quote, held locally until reveal.
//
// BLUEPRINT B3 and MECHANICS §10: "A dealer who closes their tab loses the nonce
// and forfeits." The commit is keccak256(price, quantity, nonce, dealer) and the
// venue only ever sees that hash — so if the browser loses the preimage, nobody
// on earth can reveal that quote. localStorage plus a loud warning is the whole
// mitigation, and it has to be reliable.
import { useCallback, useEffect, useState } from 'react';

export interface SealedQuote {
  rfqId: string;
  dealer: string;
  /** cash base units per one whole asset unit */
  price: string;
  quantity: string;
  minQuantity?: string;
  nonce: `0x${string}`;
  commitHash: `0x${string}`;
  savedAt: number;
  revealedAt?: number;
}

const KEY = 'sotto.sealed-quotes.v1';

function readAll(): SealedQuote[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SealedQuote[]) : [];
  } catch {
    return []; // corrupt or unavailable storage must not break the portal
  }
}

function writeAll(list: SealedQuote[]): boolean {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false; // private mode or quota — the caller warns the dealer
  }
}

const sameQuote = (a: SealedQuote, rfqId: string, dealer: string) =>
  a.rfqId === rfqId && a.dealer.toLowerCase() === dealer.toLowerCase();

export function useCommitStore(dealer: string | null | undefined) {
  const [quotes, setQuotes] = useState<SealedQuote[]>([]);
  const [storageWorks, setStorageWorks] = useState(true);

  useEffect(() => {
    setQuotes(readAll());
    // Prove storage is writable now, not at the moment the dealer needs it.
    try {
      const probe = '__sotto_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      setStorageWorks(true);
    } catch {
      setStorageWorks(false);
    }
  }, []);

  // Another tab quoting as another dealer stays in sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setQuotes(readAll()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const save = useCallback((q: SealedQuote): boolean => {
    const next = [...readAll().filter((x) => !sameQuote(x, q.rfqId, q.dealer)), q];
    const ok = writeAll(next);
    setQuotes(next);
    return ok;
  }, []);

  const markRevealed = useCallback((rfqId: string, d: string) => {
    const next = readAll().map((x) =>
      sameQuote(x, rfqId, d) ? { ...x, revealedAt: Math.floor(Date.now() / 1000) } : x
    );
    writeAll(next);
    setQuotes(next);
  }, []);

  const remove = useCallback((rfqId: string, d: string) => {
    const next = readAll().filter((x) => !sameQuote(x, rfqId, d));
    writeAll(next);
    setQuotes(next);
  }, []);

  const get = useCallback(
    (rfqId: string): SealedQuote | null => {
      if (!dealer) return null;
      return quotes.find((x) => sameQuote(x, rfqId, dealer)) ?? null;
    },
    [quotes, dealer]
  );

  const mine = dealer
    ? quotes.filter((q) => q.dealer.toLowerCase() === dealer.toLowerCase())
    : [];

  return { quotes, mine, get, save, markRevealed, remove, storageWorks };
}
