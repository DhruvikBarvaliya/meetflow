import { Check, Minus } from 'lucide-react';
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
  description?: ReactNode;
  indeterminate?: boolean;
  error?: string;
}

/**
 * A real `<input type="checkbox">` kept in the accessibility tree and visually
 * replaced by the box beside it. The native control keeps space-bar toggling,
 * form participation and the OS's own high-contrast rendering.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, indeterminate = false, error, className, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const describedById = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-start gap-2.5">
        <span className="relative flex size-5 shrink-0 items-center justify-center">
          <input
            ref={ref}
            id={inputId}
            type="checkbox"
            className="peer size-5 cursor-pointer appearance-none rounded-sm border border-border-strong bg-surface transition-colors checked:border-brand checked:bg-brand indeterminate:border-brand indeterminate:bg-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-55"
            aria-describedby={[describedById, errorId].filter(Boolean).join(' ') || undefined}
            aria-invalid={error ? true : undefined}
            {...props}
          />
          <span
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-on-brand opacity-0 peer-checked:opacity-100"
            aria-hidden="true"
          >
            {indeterminate ? <Minus className="size-3.5" /> : <Check className="size-3.5" />}
          </span>
        </span>

        <span className="flex flex-col gap-0.5">
          <label htmlFor={inputId} className="cursor-pointer text-sm font-medium text-fg">
            {label}
          </label>
          {description ? (
            <span id={describedById} className="text-xs leading-relaxed text-fg-muted">
              {description}
            </span>
          ) : null}
        </span>
      </div>

      {error ? (
        <p id={errorId} className="pl-7.5 text-xs font-medium text-danger-text" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
});
