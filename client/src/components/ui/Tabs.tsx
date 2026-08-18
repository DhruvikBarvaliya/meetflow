import { useCallback, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<TValue extends string = string> {
  value: TValue;
  label: string;
  icon?: ReactNode;
  /** Rendered as a count pill after the label. Must be a real number. */
  count?: number;
  disabled?: boolean;
}

export interface TabsProps<TValue extends string = string> {
  items: Array<TabItem<TValue>>;
  value: TValue;
  onValueChange: (value: TValue) => void;
  label: string;
  className?: string;
  children?: ReactNode;
}

/**
 * Tablist with the standard roving-tabindex behaviour: one Tab stop for the
 * whole set, arrow keys to move between tabs, Home/End to the ends.
 *
 * Selection follows focus, which is the right choice here because every panel
 * is already loaded or loads instantly — the alternative (Enter to activate)
 * only earns its extra keystroke when moving is expensive.
 */
export function Tabs<TValue extends string = string>({
  items,
  value,
  onValueChange,
  label,
  className,
  children,
}: TabsProps<TValue>): JSX.Element {
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const move = useCallback(
    (direction: number) => {
      const enabled = items.filter((item) => item.disabled !== true);
      const current = enabled.findIndex((item) => item.value === value);
      const next = enabled[(current + direction + enabled.length) % enabled.length];
      if (!next) return;
      onValueChange(next.value);
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-tab-value="${CSS.escape(next.value)}"]`)
        ?.focus();
    },
    [items, value, onValueChange],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          move(1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          move(-1);
          break;
        case 'Home': {
          event.preventDefault();
          const first = items.find((item) => item.disabled !== true);
          if (first) onValueChange(first.value);
          break;
        }
        case 'End': {
          event.preventDefault();
          const last = [...items].reverse().find((item) => item.disabled !== true);
          if (last) onValueChange(last.value);
          break;
        }
        default:
          break;
      }
    },
    [items, move, onValueChange],
  );

  return (
    <div className={cn('flex flex-col', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className="mf-scroll-x flex items-center gap-1 border-b border-border"
      >
        {items.map((item) => {
          const selected = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={`${id}-tab-${item.value}`}
              data-tab-value={item.value}
              aria-selected={selected}
              aria-controls={`${id}-panel-${item.value}`}
              tabIndex={selected ? 0 : -1}
              disabled={item.disabled}
              onClick={() => onValueChange(item.value)}
              className={cn(
                'inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
                'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-focus',
                'disabled:pointer-events-none disabled:opacity-55',
                selected
                  ? 'border-brand text-brand-text'
                  : 'border-transparent text-fg-muted hover:border-border-strong hover:text-fg',
              )}
            >
              {item.icon ? (
                <span aria-hidden="true" className="flex size-4 items-center justify-center">
                  {item.icon}
                </span>
              ) : null}
              {item.label}
              {typeof item.count === 'number' ? (
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums',
                    selected
                      ? 'bg-brand-subtle text-brand-text'
                      : 'bg-surface-sunken text-fg-muted',
                  )}
                >
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {children ? (
        <div
          role="tabpanel"
          id={`${id}-panel-${value}`}
          aria-labelledby={`${id}-tab-${value}`}
          tabIndex={0}
          className="pt-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
