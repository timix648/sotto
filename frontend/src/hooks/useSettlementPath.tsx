'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type SettlementPath = 'A' | 'B';

const STORAGE_KEY = 'sotto.settlement-path';

type SettlementPathContextValue = {
  path: SettlementPath;
  setPath: (path: SettlementPath) => void;
  togglePath: () => void;
};

const SettlementPathContext = createContext<SettlementPathContextValue | null>(null);

export function SettlementPathProvider({ children }: { children: ReactNode }) {
  const [path, setPathState] = useState<SettlementPath>('A');

  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === 'B') setPathState('B');
    } catch {
      // Private browsing may disable storage; Path A is the safe default.
    }
  }, []);

  const setPath = useCallback((next: SettlementPath) => {
    setPathState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The in-memory choice still works when storage is unavailable.
    }
  }, []);

  const togglePath = useCallback(() => {
    setPathState((current) => {
      const next = current === 'A' ? 'B' : 'A';
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // The in-memory choice still works when storage is unavailable.
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ path, setPath, togglePath }), [path, setPath, togglePath]);

  return (
    <SettlementPathContext.Provider value={value}>
      {children}
    </SettlementPathContext.Provider>
  );
}

export function useSettlementPath(): SettlementPathContextValue {
  const value = useContext(SettlementPathContext);
  if (!value) throw new Error('useSettlementPath must be used inside SettlementPathProvider');
  return value;
}
