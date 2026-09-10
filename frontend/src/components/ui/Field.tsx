'use client';

import type { InputHTMLAttributes, SelectHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Field({
  label, hint, error, suffix, className, children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  suffix?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-sm font-medium text-muted">{label}</span>
      <span className="relative block">
        {children}
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-dim">
            {suffix}
          </span>
        )}
      </span>
      {error ? (
        <span className="mt-1.5 block text-[13px] text-neg">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[13px] leading-relaxed text-dim">{hint}</span>
      ) : null}
    </label>
  );
}

const inputBase =
  'w-full bg-raised border border-line rounded-md px-3 py-2.5 text-sm text-txt num ' +
  'placeholder:text-dim focus:border-wine focusable transition-colors ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export function Input({ className, invalid, ...rest }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input {...rest} className={cn(inputBase, invalid && 'border-neg/60', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cn(inputBase, 'appearance-none pr-8', className)}>
      {children}
    </select>
  );
}

/** An inline error, in the shape MECHANICS §4.10 asks for: the real reason,
 *  plus the route back in — never a dead end. */
export function Callout({
  tone = 'neg', title, children, action,
}: {
  tone?: 'neg' | 'held' | 'pos' | 'muted';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const tones = {
    neg: 'border-neg/40 bg-neg/[0.07] text-neg',
    held: 'border-held/40 bg-held/[0.07] text-held',
    pos: 'border-pos/40 bg-pos/[0.07] text-pos',
    muted: 'border-line bg-raised text-muted',
  } as const;

  return (
    <div className={cn('border-l-2 px-4 py-3 text-sm leading-relaxed', tones[tone])}>
      {title && <div className="font-medium">{title}</div>}
      {children && <div className={cn(title && 'mt-1', 'opacity-90')}>{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
