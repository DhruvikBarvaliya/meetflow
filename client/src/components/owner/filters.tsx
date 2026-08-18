import { Search, X } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Input } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * The filter row that sits above a table or a chart grid.
 *
 * One row, above the content, on every screen that has filters — so a user who
 * learns where they are on the diary finds them in the same place on the
 * waitlist. It scrolls horizontally rather than wrapping into a tall stack on
 * a phone, which would push the data below the fold.
 */
export function FilterBar({
  children,
  className,
  label = 'Filters',
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex flex-wrap items-end gap-3', className)}
    >
      {children}
    </div>
  );
}

/**
 * A labelled filter control.
 *
 * The label is a real `<label>` rather than a placeholder: a placeholder
 * disappears the moment the control has a value, which is exactly when a user
 * scanning a row of five filters needs to know what the value means.
 */
export function FilterField({
  label,
  children,
  className,
}: {
  label: string;
  children: (props: { id: string }) => ReactNode;
  className?: string;
}): JSX.Element {
  const id = useId();
  return (
    <div className={cn('flex min-w-[9rem] flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      {children({ id })}
    </div>
  );
}

export interface SearchFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/** A search box with a clear button, wired to a real label. */
export function SearchField({
  label,
  value,
  onChange,
  placeholder,
  className,
}: SearchFieldProps): JSX.Element {
  const id = useId();
  return (
    <div className={cn('flex min-w-[12rem] flex-1 flex-col gap-1 sm:max-w-xs', className)}>
      <label htmlFor={id} className="text-xs font-medium text-fg-muted">
        {label}
      </label>
      <Input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        leadingIcon={<Search className="size-4" aria-hidden="true" />}
        trailingSlot={
          value !== '' ? (
            <button
              type="button"
              onClick={() => onChange('')}
              aria-label={`Clear ${label.toLowerCase()}`}
              className="flex size-6 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null
        }
      />
    </div>
  );
}

/**
 * Delays a value until the user stops changing it.
 *
 * Search boxes on this API are rate limited per IP, and a request per keystroke
 * both wastes that budget and produces results that flicker between prefixes.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
