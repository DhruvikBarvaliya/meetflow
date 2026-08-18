import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import type { PageMeta } from '@/types/api';
import { Button } from './Button';

export interface PaginationProps {
  meta: PageMeta;
  onPageChange: (page: number) => void;
  className?: string;
  /** What the totals count, for the summary line ("appointments"). */
  itemLabel?: string;
}

/** Page numbers around the current one, with `null` where an ellipsis goes. */
function pageWindow(current: number, total: number): Array<number | null> {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);

  const result: Array<number | null> = [];
  let previous = 0;
  for (const page of sorted) {
    if (previous !== 0 && page - previous > 1) result.push(null);
    result.push(page);
    previous = page;
  }
  return result;
}

/**
 * Every figure here comes from the API's `meta`; nothing is inferred from the
 * length of the page currently in hand.
 */
export function Pagination({
  meta,
  onPageChange,
  className,
  itemLabel = 'results',
}: PaginationProps): JSX.Element | null {
  const { page, pageSize, totalItems, totalPages } = meta;
  if (totalItems === 0) return null;

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalItems);

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3',
        className,
      )}
    >
      <p className="text-sm text-fg-muted" aria-live="polite">
        Showing <span className="font-medium text-fg">{formatNumber(first)}</span>–
        <span className="font-medium text-fg">{formatNumber(last)}</span> of{' '}
        <span className="font-medium text-fg">{formatNumber(totalItems)}</span> {itemLabel}
      </p>

      {totalPages > 1 ? (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Previous</span>
          </Button>

          <ul className="hidden items-center gap-1 sm:flex">
            {pageWindow(page, totalPages).map((entry, index) =>
              entry === null ? (
                <li key={`gap-${index}`} className="px-1 text-sm text-fg-muted" aria-hidden="true">
                  …
                </li>
              ) : (
                <li key={entry}>
                  <button
                    type="button"
                    onClick={() => onPageChange(entry)}
                    aria-current={entry === page ? 'page' : undefined}
                    aria-label={`Page ${entry}`}
                    className={cn(
                      'inline-flex size-8 items-center justify-center rounded-md text-sm font-medium tabular-nums transition-colors',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                      entry === page
                        ? 'bg-brand text-on-brand'
                        : 'text-fg-secondary hover:bg-surface-hover',
                    )}
                  >
                    {entry}
                  </button>
                </li>
              ),
            )}
          </ul>

          <span className="text-sm text-fg-muted sm:hidden">
            {page} / {totalPages}
          </span>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPageChange(page + 1)}
            disabled={!meta.hasNextPage}
            aria-label="Next page"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </nav>
  );
}
