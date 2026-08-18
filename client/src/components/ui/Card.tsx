import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `flat` drops the shadow — for cards nested inside another surface. */
  variant?: 'raised' | 'flat';
}

export function Card({
  variant = 'raised',
  className,
  children,
  ...props
}: CardProps): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-surface',
        variant === 'raised' && 'shadow-sm',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  /** Heading level, so a card in a section does not break the document outline. */
  as?: 'h2' | 'h3' | 'h4';
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  as: Heading = 'h3',
}: CardHeaderProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <Heading className="text-sm font-semibold tracking-tight text-fg">{title}</Heading>
        {description ? (
          <p className="text-sm leading-relaxed text-fg-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div className={cn('px-5 py-4', className)} {...props}>
      {children}
    </div>
  );
}

export function CardFooter({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-sunken px-5 py-3',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
