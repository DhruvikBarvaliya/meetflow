import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, type ButtonProps } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface CopyButtonProps {
  value: string;
  /** What is being copied, for the accessible label ("booking link"). */
  label: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
  children?: React.ReactNode;
}

const CONFIRMATION_MS = 2000;

/**
 * Copies a value and says so.
 *
 * The confirmation lives in an `aria-live` region as well as in the icon,
 * because "the tick swapped in" is not an event a screen-reader user can
 * observe. `navigator.clipboard` is unavailable on an insecure origin, so the
 * failure path tells the user to copy by hand rather than silently doing
 * nothing.
 */
export function CopyButton({
  value,
  label,
  size = 'sm',
  variant = 'secondary',
  className,
  children,
}: CopyButtonProps): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setState('idle'), CONFIRMATION_MS);
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => void copy()}
        aria-label={`Copy ${label}`}
        leadingIcon={
          state === 'copied' ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )
        }
      >
        {children ?? (state === 'copied' ? 'Copied' : 'Copy')}
      </Button>
      <span role="status" aria-live="polite" className="mf-sr-only">
        {state === 'copied'
          ? `${label} copied to the clipboard`
          : state === 'failed'
            ? `Could not copy the ${label}. Select the text and copy it manually.`
            : ''}
      </span>
    </>
  );
}

/** A read-only URL beside its copy button — the shape a share row always takes. */
export function CopyableUrl({
  url,
  label,
  className,
}: {
  url: string;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <code className="mf-scroll-x min-w-0 flex-1 truncate rounded-md border border-border bg-surface-sunken px-2.5 py-1.5 font-mono text-xs text-fg-secondary">
        {url}
      </code>
      <CopyButton value={url} label={label} />
    </div>
  );
}
