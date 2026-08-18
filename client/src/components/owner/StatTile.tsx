import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface StatTileProps {
  label: string;
  /** Already formatted. Pass the string, not the raw number. */
  value: string;
  /** One short line of context — what the figure is counted over. */
  caption?: ReactNode;
  icon?: LucideIcon;
  /**
   * A secondary reading of the same measure, e.g. the rate behind a count.
   * Never a target, a projection or a comparison the API did not supply.
   */
  detail?: string;
  tone?: 'default' | 'positive' | 'negative' | 'attention';
  /** Renders the skeleton instead of the figure. */
  isLoading?: boolean;
  className?: string;
}

const TONES: Record<NonNullable<StatTileProps['tone']>, string> = {
  default: 'text-fg',
  positive: 'text-success-text',
  negative: 'text-danger-text',
  attention: 'text-warning-text',
};

const ICON_TONES: Record<NonNullable<StatTileProps['tone']>, string> = {
  default: 'bg-surface-sunken text-fg-muted',
  positive: 'bg-success-subtle text-success-text',
  negative: 'bg-danger-subtle text-danger-text',
  attention: 'bg-warning-subtle text-warning-text',
};

/**
 * One number, said plainly.
 *
 * A stat tile is the right form when a measure has no shape worth plotting —
 * "eleven bookings this month" is a fact, not a trend, and a two-bar chart of
 * it would be decoration. The figure is the largest thing in the tile and every
 * other element recedes from it.
 *
 * There is no placeholder value: while the number is unknown the tile shows a
 * skeleton, never a zero. A zero that turns out to be a loading state is the
 * single most damaging thing a dashboard can print.
 */
export function StatTile({
  label,
  value,
  caption,
  icon: Icon,
  detail,
  tone = 'default',
  isLoading = false,
  className,
}: StatTileProps): JSX.Element {
  return (
    <Card className={cn('flex items-start gap-4 p-5', className)}>
      {Icon ? (
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-md',
            ICON_TONES[tone],
          )}
          aria-hidden="true"
        >
          <Icon className="size-4.5" />
        </span>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</p>

        {isLoading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <p className={cn('text-2xl font-semibold tracking-tight tabular-nums', TONES[tone])}>
            {value}
          </p>
        )}

        {detail && !isLoading ? (
          <p className="text-sm font-medium tabular-nums text-fg-secondary">{detail}</p>
        ) : null}

        {caption ? <p className="text-xs leading-relaxed text-fg-muted">{caption}</p> : null}
      </div>
    </Card>
  );
}

/**
 * A row of tiles that reflows to one column on a phone.
 *
 * The wide-screen column count is explicit rather than automatic because it has
 * to divide the number of tiles: four columns holding six tiles leaves two
 * stranded on a second row, which reads as "these two are different" when they
 * are not.
 */
export function StatTileGrid({
  children,
  columns = 4,
  className,
}: {
  children: ReactNode;
  columns?: 3 | 4;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={cn(
        'grid gap-4 sm:grid-cols-2',
        columns === 3 ? 'xl:grid-cols-3' : 'xl:grid-cols-4',
        className,
      )}
    >
      {children}
    </div>
  );
}
