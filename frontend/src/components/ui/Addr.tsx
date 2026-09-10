'use client';

// B6: "Monospace for addresses and hashes, always truncated 0x1234…abcd with
// click-to-copy." Every identifier in the venue renders through this component,
// so an address can never appear in two different shapes on two panels —
// MECHANICS §4.10 lists exactly that as a trust failure.
import { useState, useCallback } from 'react';
import { truncate, truncateHash } from '@/lib/format';
import { cn } from '@/lib/cn';

export function Addr({
  value, kind = 'address', href, label, className,
}: {
  value: string | null | undefined;
  kind?: 'address' | 'hash';
  /** When given, an explorer link is rendered beside the copy target. */
  href?: string | null;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return; // clipboard blocked; say nothing rather than show a false success
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }, [value]);

  if (!value) return <span className="font-mono text-xs text-dim">—</span>;

  const shown = kind === 'hash' ? truncateHash(value) : truncate(value);

  return (
    <span className={cn('inline-flex items-center gap-1.5 align-middle', className)}>
      {label && <span className="label">{label}</span>}
      <button
        type="button"
        onClick={copy}
        title={`${value}  (click to copy)`}
        className={cn(
          'font-mono text-xs rounded px-1 py-0.5 -mx-1 focusable transition-colors',
          copied ? 'text-pos bg-pos/10' : 'text-muted hover:text-txt hover:bg-raised'
        )}
      >
        {copied ? 'copied' : shown}
      </button>
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title="View on HashScan"
          className="text-dim hover:text-txt text-2xs focusable rounded transition-colors"
        >
          ↗
        </a>
      )}
    </span>
  );
}

/** A labelled HashScan link, used where the target is a verifiable claim. */
export function HashScanLink({
  href, children, className,
}: {
  href: string | null;
  children?: React.ReactNode;
  className?: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex items-center gap-1 text-xs text-muted hover:text-txt underline underline-offset-2 decoration-line hover:decoration-current focusable rounded transition-colors',
        className
      )}
    >
      {children ?? 'HashScan'} <span aria-hidden>↗</span>
    </a>
  );
}
