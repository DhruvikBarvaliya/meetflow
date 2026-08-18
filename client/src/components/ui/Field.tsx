import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface FieldProps {
  label: string;
  /** Explanatory text; wired to the control through aria-describedby. */
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  /**
   * Receives the ids and state the control needs. Making this a render prop is
   * what guarantees the label, hint and error are actually associated with the
   * input rather than merely sitting next to it.
   */
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
    'aria-required': boolean | undefined;
  }) => ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps): JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {label}
        {required ? (
          <span className="ml-1 text-danger-text" aria-hidden="true">
            *
          </span>
        ) : null}
        {required ? <span className="mf-sr-only"> (required)</span> : null}
      </label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required || undefined,
      })}

      {hint ? (
        <p id={hintId} className="text-xs leading-relaxed text-fg-muted">
          {hint}
        </p>
      ) : null}

      {error ? (
        // Polite rather than assertive: validation fires on every blur, and an
        // assertive region would interrupt the user mid-sentence.
        <p id={errorId} className="text-xs font-medium text-danger-text" aria-live="polite">
          {error}
        </p>
      ) : null}
    </div>
  );
}
