import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TooltipProps {
  /** Plain text only — a tooltip must never be the sole home of interactive content. */
  content: string;
  children: ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}

/**
 * A supplementary label on hover *and* focus.
 *
 * Two rules make this usable rather than decorative:
 *  - It is wired with `aria-describedby`, so it supplements the trigger's own
 *    accessible name instead of replacing it. A control whose only label is a
 *    tooltip is unlabelled to anyone who cannot hover.
 *  - Escape dismisses it, which WCAG 1.4.13 requires for any content that
 *    appears on hover.
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const show = (): void => {
    window.clearTimeout(timerRef.current);
    // A short delay stops tooltips flickering as the pointer crosses a toolbar.
    timerRef.current = window.setTimeout(() => setOpen(true), 250);
  };

  const hide = (): void => {
    window.clearTimeout(timerRef.current);
    setOpen(false);
  };

  return (
    <span
      className={cn('relative inline-flex', className)}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={hide}
      aria-describedby={open ? id : undefined}
    >
      {children}
      {open ? (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'mf-animate-fade-in pointer-events-none absolute left-1/2 z-50 w-max max-w-56 -translate-x-1/2 rounded-md border border-border bg-surface px-2 py-1 text-xs font-medium text-fg shadow-lg',
            side === 'top' ? 'bottom-[calc(100%+0.375rem)]' : 'top-[calc(100%+0.375rem)]',
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  );
}
