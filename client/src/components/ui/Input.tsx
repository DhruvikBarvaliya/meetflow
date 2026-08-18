import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export const controlStyles =
  'w-full rounded-md border border-border bg-surface text-fg shadow-xs transition-colors ' +
  'duration-[var(--mf-duration-fast)] placeholder:text-fg-muted ' +
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus ' +
  'focus-visible:border-brand disabled:cursor-not-allowed disabled:bg-surface-sunken ' +
  'disabled:text-fg-muted aria-[invalid=true]:border-danger';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Rendered inside the field, before the text. Decorative only. */
  leadingIcon?: ReactNode;
  /** Rendered inside the field, after the text — e.g. a show-password toggle. */
  trailingSlot?: ReactNode;
  inputSize?: 'sm' | 'md';
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { leadingIcon, trailingSlot, inputSize = 'md', className, ...props },
  ref,
) {
  const height = inputSize === 'sm' ? 'h-8 text-sm' : 'h-10 text-sm';
  const paddingLeft = leadingIcon ? 'pl-9' : 'pl-3';
  const paddingRight = trailingSlot ? 'pr-10' : 'pr-3';

  const field = (
    <input
      ref={ref}
      className={cn(controlStyles, height, paddingLeft, paddingRight, className)}
      {...props}
    />
  );

  if (!leadingIcon && !trailingSlot) return field;

  return (
    <div className="relative">
      {leadingIcon ? (
        <span
          className="pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-fg-muted"
          aria-hidden="true"
        >
          {leadingIcon}
        </span>
      ) : null}
      {field}
      {trailingSlot ? (
        <span className="absolute inset-y-0 right-0 flex w-10 items-center justify-center">
          {trailingSlot}
        </span>
      ) : null}
    </div>
  );
});
