import {
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import { Popover, type PopoverAlign } from './Popover';

export interface DropdownMenuProps {
  /** The control that opens the menu. Receives the wiring it needs. */
  trigger: (props: {
    ref: (node: HTMLButtonElement | null) => void;
    onClick: () => void;
    onKeyDown: (event: ReactKeyboardEvent) => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    id: string;
    'aria-controls': string;
  }) => ReactNode;
  children: ReactNode;
  align?: PopoverAlign;
  label: string;
  className?: string;
  menuClassName?: string;
}

/**
 * A `role="menu"` with the keyboard behaviour the pattern requires: Down/Up
 * move between items and wrap, Home/End jump to the ends, Escape closes and
 * returns focus to the trigger.
 *
 * Items are found from the DOM on each keypress rather than tracked in state,
 * so a caller can render them conditionally (by permission, say) without the
 * arrow keys walking onto an item that is no longer there.
 */
export function DropdownMenu({
  trigger,
  children,
  align = 'end',
  label,
  className,
  menuClassName,
}: DropdownMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const triggerId = `${id}-trigger`;
  const menuId = `${id}-menu`;

  const items = useCallback((): HTMLElement[] => {
    const menu = wrapperRef.current?.querySelector<HTMLElement>(`#${CSS.escape(menuId)}`);
    if (!menu) return [];
    return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
  }, [menuId]);

  const focusItem = useCallback(
    (index: number) => {
      const list = items();
      if (list.length === 0) return;
      const wrapped = ((index % list.length) + list.length) % list.length;
      list[wrapped]?.focus();
    },
    [items],
  );

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  const openAt = useCallback(
    (position: 'first' | 'last') => {
      setOpen(true);
      // The panel mounts on this render, so focus has to wait a frame.
      requestAnimationFrame(() => focusItem(position === 'first' ? 0 : items().length - 1));
    },
    [focusItem, items],
  );

  const onTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openAt('first');
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        openAt('last');
      }
    },
    [openAt],
  );

  const onMenuKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const list = items();
      const current = list.indexOf(document.activeElement as HTMLElement);

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          focusItem(current + 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          focusItem(current - 1);
          break;
        case 'Home':
          event.preventDefault();
          focusItem(0);
          break;
        case 'End':
          event.preventDefault();
          focusItem(list.length - 1);
          break;
        case 'Tab':
          // Tabbing out of a menu closes it, but must not swallow the move.
          close(false);
          break;
        default:
          break;
      }
    },
    [items, focusItem, close],
  );

  return (
    <div ref={wrapperRef} className={cn('relative', className)}>
      {trigger({
        ref: (node) => {
          triggerRef.current = node;
        },
        onClick: () => (open ? close() : setOpen(true)),
        onKeyDown: onTriggerKeyDown,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        id: triggerId,
        'aria-controls': menuId,
      })}

      <Popover open={open} onClose={() => close()} align={align} anchorRef={wrapperRef}>
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          aria-labelledby={triggerId}
          onKeyDown={onMenuKeyDown}
          onClick={() => close()}
          className={cn('flex min-w-[11rem] flex-col', menuClassName)}
        >
          {children}
        </div>
      </Popover>
    </div>
  );
}

export interface DropdownItemProps {
  children: ReactNode;
  onSelect?: () => void;
  icon?: ReactNode;
  disabled?: boolean;
  /** Styles the item as destructive; pair with a confirmation dialog. */
  destructive?: boolean;
  className?: string;
}

export function DropdownItem({
  children,
  onSelect,
  icon,
  disabled = false,
  destructive = false,
  className,
}: DropdownItemProps): JSX.Element {
  return (
    <button
      type="button"
      role="menuitem"
      // -1 keeps the item out of the Tab order; the menu's arrow keys own focus.
      tabIndex={-1}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
        'disabled:pointer-events-none disabled:opacity-55',
        destructive
          ? 'text-danger-text hover:bg-danger-subtle focus:bg-danger-subtle'
          : 'text-fg-secondary hover:bg-surface-hover hover:text-fg focus:bg-surface-hover focus:text-fg',
        className,
      )}
    >
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

export interface DropdownLinkItemProps {
  children: ReactNode;
  to: string;
  icon?: ReactNode;
  className?: string;
}

/**
 * A menu item that navigates.
 *
 * A separate component because an `<a>` inside a `<button>` is invalid HTML and
 * swallows keyboard activation — the anchor has to *be* the menu item.
 */
export function DropdownLinkItem({
  children,
  to,
  icon,
  className,
}: DropdownLinkItemProps): JSX.Element {
  return (
    <Link
      to={to}
      role="menuitem"
      tabIndex={-1}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-fg-secondary transition-colors',
        'hover:bg-surface-hover hover:text-fg focus:bg-surface-hover focus:text-fg',
        'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
        className,
      )}
    >
      {icon ? (
        <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </Link>
  );
}

export function DropdownSeparator(): JSX.Element {
  return <hr className="my-1 border-t border-border" role="separator" />;
}

export function DropdownLabel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">
      {children}
    </p>
  );
}
