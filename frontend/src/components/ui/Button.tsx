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
    'transition-[transform,background-color,border-color,color] duration-200 ease-out ' +
    'hover:-translate-y-0.5 active:translate-y-0 focusable disabled:translate-y-0 ' +
    'disabled:opacity-40 disabled:cursor-not-allowed select-none';

  const variants: Record<Variant, string> = {
    primary: 'border-2 border-brand bg-brand text-brandTxt hover:border-wine hover:bg-wine',
    danger: 'border-2 border-neg/40 bg-neg/10 text-neg hover:bg-neg/20',
    ghost: 'border-2 border-line bg-raised text-txt hover:border-wine hover:bg-wineWash',
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
