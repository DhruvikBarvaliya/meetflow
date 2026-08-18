import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'accent';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-surface-sunken text-fg-secondary border-border',
  brand: 'bg-brand-subtle text-brand-text border-brand-border',
  success: 'bg-success-subtle text-success-text border-success-border',
  warning: 'bg-warning-subtle text-warning-text border-warning-border',
  danger: 'bg-danger-subtle text-danger-text border-danger-border',
  info: 'bg-info-subtle text-info-text border-info-border',
  accent: 'bg-accent-subtle text-accent-text border-transparent',
};

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  /** A small filled circle before the text — for status pills. */
  dot?: boolean;
}

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
  className,
}: BadgeProps): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
