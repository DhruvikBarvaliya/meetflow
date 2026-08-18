import { ChevronDown } from 'lucide-react';
import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { controlStyles } from './Input';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  /** Rendered as a disabled first option, for "choose one" states. */
  placeholder?: string;
  selectSize?: 'sm' | 'md';
}

/**
 * A styled native `<select>`.
 *
 * Deliberately not a custom listbox: the native control gets mobile's wheel
 * picker, type-ahead, and the platform's own screen-reader behaviour for free,
 * none of which a div-based replacement matches. `TimePicker` is the one place
 * that needs a custom listbox, and it says why.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, placeholder, selectSize = 'md', className, defaultValue, value, ...props },
  ref,
) {
  const height = selectSize === 'sm' ? 'h-8 text-sm' : 'h-10 text-sm';

  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(controlStyles, height, 'appearance-none pl-3 pr-9', className)}
        value={value}
        defaultValue={value === undefined && placeholder ? (defaultValue ?? '') : defaultValue}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-muted"
        aria-hidden="true"
      />
    </div>
  );
});
