import type { ReactNode } from 'react';
import { ErrorState, SkeletonTable } from '@/components/ui';

export interface DataStateProps {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  /** True when the request succeeded and there is nothing to show. */
  isEmpty: boolean;
  /** An `<EmptyState>` with a next action — never a bare "no results". */
  empty: ReactNode;
  /** Defaults to a table skeleton; pass one shaped like the real content. */
  skeleton?: ReactNode;
  children: ReactNode;
  /** Columns for the default table skeleton. */
  columns?: number;
  rows?: number;
}

/**
 * The four states every list on this surface can be in.
 *
 * Centralised so that "loading" never renders as an empty table and "empty"
 * never renders as a failure. Those two confusions are the ones that cost an
 * operator the most: one makes them think the data is gone, the other makes
 * them think the product is broken.
 *
 * The whole region is a polite live region, so a screen reader is told when the
 * content it is standing in has been replaced.
 */
export function DataState({
  isPending,
  isError,
  error,
  onRetry,
  isEmpty,
  empty,
  skeleton,
  children,
  columns = 5,
  rows = 6,
}: DataStateProps): JSX.Element {
  return (
    <div aria-live="polite" aria-busy={isPending}>
      {isPending ? (
        <>
          <span className="mf-sr-only">Loading</span>
          {skeleton ?? <SkeletonTable columns={columns} rows={rows} />}
        </>
      ) : isError ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : isEmpty ? (
        empty
      ) : (
        children
      )}
    </div>
  );
}
