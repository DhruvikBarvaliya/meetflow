import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

/**
 * A `role="switch"` button rather than a checkbox.
 *
 * The distinction matters to screen-reader users: a checkbox is announced as
 * "checked", which reads as "selected for later", while a switch is announced
 * as "on" — the immediate, self-applying change this control actually makes.
 */
export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled = false,
  className,
}: SwitchProps): JSX.Element {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = description ? `${id}-description` : undefined;

  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <span className="flex flex-col gap-0.5">
        <span id={labelId} className="text-sm font-medium text-fg">
          {label}
        </span>
        {description ? (
          <span id={descriptionId} className="text-xs leading-relaxed text-fg-muted">
            {description}
          </span>
        ) : null}
      </span>

      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        disabled={disabled}
        onClick={() => onCheckedChange(!checked)}
        className={cn(
          'relative mt-0.5 inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border border-transparent transition-colors duration-[var(--mf-duration-fast)]',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          'disabled:cursor-not-allowed disabled:opacity-55',
          checked ? 'bg-brand' : 'bg-surface-active',
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute top-0.5 size-5 rounded-full bg-surface shadow-sm transition-transform duration-[var(--mf-duration-fast)]',
            checked ? 'translate-x-5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}
