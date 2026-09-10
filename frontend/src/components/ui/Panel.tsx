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
    <section className={cn('bg-panel border rounded-md', toneRing, className)}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-base font-semibold leading-tight text-txt">{title}</h2>}
            {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-dim">{subtitle}</p>}
          </div>
          {right && <div className="shrink-0">{right}</div>}
        </header>
      )}
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="py-10 text-center text-sm text-dim">
      {children}
    </div>
  );
}
