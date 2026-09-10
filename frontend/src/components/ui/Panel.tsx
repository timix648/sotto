import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Panel({
  title, subtitle, right, children, className, bodyClassName, tone = 'default',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  tone?: 'default' | 'danger' | 'success' | 'held';
}) {
  const toneRing =
    tone === 'danger' ? 'border-neg/40' :
    tone === 'success' ? 'border-pos/40' :
    tone === 'held' ? 'border-held/40' : 'border-line';

  return (
    <section className={cn('bg-panel border rounded-lg', toneRing, className)}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 px-4 py-3 border-b border-line">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-medium text-txt leading-tight">{title}</h2>}
            {subtitle && <p className="text-2xs text-dim mt-0.5 leading-tight">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="py-10 text-center text-sm text-dim border border-dashed border-line rounded-md">
      {children}
    </div>
  );
}
