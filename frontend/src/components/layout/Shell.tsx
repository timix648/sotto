import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** The standard page gutter for the portals. The home page opts out of this so
 *  its sections can run full-bleed. */
export function Shell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6', className)}>
      {children}
    </div>
  );
}
