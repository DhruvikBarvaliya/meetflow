import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { useOnClickOutside } from '@/hooks/useOnClickOutside';
import { cn } from '@/lib/cn';

export type PopoverAlign = 'start' | 'end' | 'center';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  align?: PopoverAlign;
  className?: string;
  /**
   * The wrapper that owns both trigger and panel. Outside-clicks are measured
   * against it, so a press on the trigger closes rather than immediately
   * reopening the panel.
   */
  anchorRef: RefObject<HTMLElement | null>;
  /** Labelling for the panel, when it is not a plain menu. */
  role?: 'dialog' | 'listbox' | 'menu' | 'none';
  ariaLabel?: string;
}

const ALIGNMENT: Record<PopoverAlign, string> = {
  start: 'left-0',
  end: 'right-0',
  center: 'left-1/2 -translate-x-1/2',
};

/**
 * A panel anchored under its trigger.
 *
 * Positioned with plain CSS rather than a floating-element library: the app has
 * no such dependency, and every popover here opens from a control in normal
 * page flow where `absolute` under a `relative` wrapper is exactly right.
 * `max-h` plus internal scrolling is what keeps a long list from running off a
 * short viewport.
 */
export function Popover({
  open,
  onClose,
  children,
  align = 'start',
  className,
  anchorRef,
  role = 'none',
  ariaLabel,
}: PopoverProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);

  useOnClickOutside(anchorRef, onClose, open);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role={role === 'none' ? undefined : role}
      aria-label={ariaLabel}
      className={cn(
        'mf-animate-pop-in absolute top-[calc(100%+0.375rem)] z-40 max-h-[min(24rem,60dvh)] min-w-[12rem] overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg',
        ALIGNMENT[align],
        className,
      )}
    >
      {children}
    </div>
  );
}
