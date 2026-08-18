import type { HTMLAttributes, ReactNode, ThHTMLAttributes, TdHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/**
 * Semantic table primitives.
 *
 * A real `<table>` rather than a grid of divs: the row/column relationships are
 * what let a screen reader announce "Service, Deep Tissue Massage" when moving
 * across a row, and no amount of ARIA on divs reproduces that reliably.
 *
 * The wrapper scrolls horizontally on its own so a wide diary never makes the
 * whole page scroll sideways on a phone.
 */
export function TableContainer({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      className={cn(
        'mf-scroll-x w-full overflow-hidden rounded-lg border border-border bg-surface',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface TableProps extends HTMLAttributes<HTMLTableElement> {
  /** Describes the table for assistive tech; visually hidden. */
  caption?: string;
}

export function Table({ caption, className, children, ...props }: TableProps): JSX.Element {
  return (
    <table className={cn('w-full border-collapse text-sm', className)} {...props}>
      {caption ? <caption className="mf-sr-only">{caption}</caption> : null}
      {children}
    </table>
  );
}

export function THead({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return (
    <thead className={cn('bg-surface-sunken', className)} {...props}>
      {children}
    </thead>
  );
}

export function TBody({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLTableSectionElement>): JSX.Element {
  return (
    <tbody className={cn('divide-y divide-border', className)} {...props}>
      {children}
    </tbody>
  );
}

export interface TrProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Adds a hover tint. Only for rows that are genuinely clickable. */
  interactive?: boolean;
}

export function Tr({ interactive = false, className, children, ...props }: TrProps): JSX.Element {
  return (
    <tr
      className={cn(
        interactive && 'cursor-pointer transition-colors hover:bg-surface-hover',
        className,
      )}
      {...props}
    >
      {children}
    </tr>
  );
}

export interface ThProps extends ThHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'center' | 'right';
}

export function Th({ align = 'left', className, children, ...props }: ThProps): JSX.Element {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-fg-muted',
        align === 'right' && 'text-right',
        align === 'center' && 'text-center',
        align === 'left' && 'text-left',
        className,
      )}
      {...props}
    >
      {children}
    </th>
  );
}

export interface TdProps extends TdHTMLAttributes<HTMLTableCellElement> {
  align?: 'left' | 'center' | 'right';
  /** Right-aligns and tabular-figures a numeric cell so columns line up. */
  numeric?: boolean;
}

export function Td({
  align,
  numeric = false,
  className,
  children,
  ...props
}: TdProps): JSX.Element {
  const resolved = align ?? (numeric ? 'right' : 'left');
  return (
    <td
      className={cn(
        'px-4 py-3 align-middle text-fg-secondary',
        numeric && 'tabular-nums',
        resolved === 'right' && 'text-right',
        resolved === 'center' && 'text-center',
        className,
      )}
      {...props}
    >
      {children}
    </td>
  );
}
