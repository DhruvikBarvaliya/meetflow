import { cn } from '@/lib/cn';

export interface SkeletonProps {
  className?: string;
}

/**
 * A loading placeholder.
 *
 * `aria-hidden` on purpose: a screen reader gains nothing from a shimmering
 * rectangle, and the surrounding region already announces its busy state.
 */
export function Skeleton({ className }: SkeletonProps): JSX.Element {
  return <div className={cn('mf-skeleton rounded-md', className)} aria-hidden="true" />;
}

export function SkeletonText({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          // The last line runs short, the way real wrapped text does.
          className={cn('h-3.5', index === lines - 1 ? 'w-2/5' : 'w-full')}
        />
      ))}
    </div>
  );
}

/** Placeholder rows matching the Table component's rhythm. */
export function SkeletonTable({
  rows = 5,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex flex-col', className)} aria-hidden="true">
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-b-0"
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton
              key={columnIndex}
              className={cn('h-4', columnIndex === 0 ? 'w-1/4' : 'flex-1')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
