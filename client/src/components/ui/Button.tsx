import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon';

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors ' +
  'duration-[var(--mf-duration-fast)] focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-55 select-none';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand shadow-xs hover:bg-brand-hover active:bg-brand-active',
  secondary:
    'bg-surface-sunken text-fg border border-border hover:bg-surface-hover active:bg-surface-active',
  outline: 'border border-border-strong bg-surface text-fg hover:bg-surface-hover',
  ghost: 'text-fg-secondary hover:bg-surface-hover hover:text-fg',
  danger: 'bg-danger text-on-danger shadow-xs hover:bg-danger-hover',
  link: 'text-brand-text underline underline-offset-4 hover:opacity-80',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-11 px-5 text-base',
  icon: 'size-10 p-0',
};

/**
 * Class list for a button, exported so a react-router `<Link>` can wear the
 * same skin without being wrapped in a real `<button>` — nesting an anchor in a
 * button is invalid HTML and breaks keyboard activation.
 */
export function buttonStyles(variant: ButtonVariant = 'primary', size: ButtonSize = 'md'): string {
  return cn(BASE, VARIANTS[variant], SIZES[size]);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks activation without collapsing the button's width. */
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    leadingIcon,
    trailingIcon,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      // Defaults to "button": an unlabelled button inside a form otherwise
      // submits it, which is how "Cancel" ends up creating a record.
      type={type}
      className={cn(buttonStyles(variant, size), fullWidth && 'w-full', className)}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size="sm" label={null} /> : leadingIcon}
      {children}
      {loading ? null : trailingIcon}
    </button>
  );
});
