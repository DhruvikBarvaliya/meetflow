import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps {
  /** A lucide icon element. Decorative. */
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** The one thing the user should do next. An empty state without one is a dead end. */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  className,
}: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      {icon ? (
        <span
          className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-fg-muted"
          aria-hidden="true"
        >
          {icon}
        </span>
      ) : null}

      <div className="flex max-w-md flex-col gap-1.5">
        <h3 className="text-base font-semibold tracking-tight text-fg">{title}</h3>
        {description ? (
          <p className="text-sm leading-relaxed text-fg-muted">{description}</p>
        ) : null}
      </div>

      {action || secondaryAction ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}
