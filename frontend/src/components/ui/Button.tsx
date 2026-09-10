'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'ghost' | 'danger' | 'quiet';

export function Button({
  children, variant = 'ghost', busy, className, ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  busy?: boolean;
  children: ReactNode;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium ' +
    'transition-colors focusable disabled:opacity-40 disabled:cursor-not-allowed select-none';

  const variants: Record<Variant, string> = {
    primary: 'bg-brand text-brandTxt border border-brand hover:opacity-90',
    danger: 'bg-neg/10 text-neg border border-neg/40 hover:bg-neg/20',
    ghost: 'bg-raised text-txt border border-line hover:border-lineBright hover:bg-raised/80',
    quiet: 'text-muted hover:text-txt border border-transparent hover:border-line',
  };

  return (
    <button
      {...rest}
      disabled={rest.disabled || busy}
      className={cn(base, variants[variant], className)}
    >
      {busy && (
        <span
          aria-hidden
          className="h-3 w-3 animate-spin rounded-full border-[2px] border-current border-r-transparent"
        />
      )}
      {children}
    </button>
  );
}
