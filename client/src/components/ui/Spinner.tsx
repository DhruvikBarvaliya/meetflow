import { cn } from '@/lib/cn';

const SIZES = {
  xs: 'size-3 border',
  sm: 'size-4 border-2',
  md: 'size-5 border-2',
  lg: 'size-8 border-2',
} as const;

export interface SpinnerProps {
  size?: keyof typeof SIZES;
  className?: string;
  /** Announced to screen readers; pass null inside a control that already says it. */
  label?: string | null;
}

export function Spinner({ size = 'md', className, label = 'Loading' }: SpinnerProps): JSX.Element {
  return (
    <span
      className={cn(
        'inline-block shrink-0 animate-spin rounded-full border-current border-r-transparent align-[-0.125em]',
        SIZES[size],
        className,
      )}
      role={label === null ? 'presentation' : 'status'}
      aria-hidden={label === null ? true : undefined}
    >
      {label !== null ? <span className="mf-sr-only">{label}</span> : null}
    </span>
  );
}
