import { AlertTriangle, RefreshCw, ShieldX, WifiOff } from 'lucide-react';
import { isApiError } from '@/lib/apiClient';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  /** Replaces the message derived from the error. */
  title?: string;
  className?: string;
}

interface Presentation {
  icon: JSX.Element;
  title: string;
  message: string;
  /** Retrying a 403 just fails again; the button is only offered where it helps. */
  canRetry: boolean;
}

function present(error: unknown): Presentation {
  if (isApiError(error)) {
    if (error.status === 0) {
      return {
        icon: <WifiOff className="size-5" aria-hidden="true" />,
        title: 'No connection',
        message: error.message,
        canRetry: true,
      };
    }
    if (error.isForbidden) {
      return {
        icon: <ShieldX className="size-5" aria-hidden="true" />,
        title: 'Not available to your role',
        message: error.message,
        canRetry: false,
      };
    }
    if (error.isNotFound) {
      return {
        icon: <AlertTriangle className="size-5" aria-hidden="true" />,
        title: 'Not found',
        message: error.message,
        canRetry: false,
      };
    }
    return {
      icon: <AlertTriangle className="size-5" aria-hidden="true" />,
      title: 'Something went wrong',
      message: error.message,
      canRetry: error.isRetryable,
    };
  }

  return {
    icon: <AlertTriangle className="size-5" aria-hidden="true" />,
    title: 'Something went wrong',
    message: 'We could not load this. Please try again.',
    canRetry: true,
  };
}

/**
 * The failure counterpart to EmptyState.
 *
 * `role="alert"` because this replaces content the user was waiting for — they
 * need to be told, not to discover it by tabbing. The request id is shown when
 * the API supplied one, so a support conversation can start with a fact.
 */
export function ErrorState({ error, onRetry, title, className }: ErrorStateProps): JSX.Element {
  const presentation = present(error);
  const requestId = isApiError(error) ? error.requestId : null;

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-14 text-center',
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-danger-subtle text-danger-text">
        {presentation.icon}
      </span>

      <div className="flex max-w-md flex-col gap-1.5">
        <h3 className="text-base font-semibold tracking-tight text-fg">
          {title ?? presentation.title}
        </h3>
        <p className="text-sm leading-relaxed text-fg-muted">{presentation.message}</p>
      </div>

      {onRetry && presentation.canRetry ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={onRetry}
          leadingIcon={<RefreshCw className="size-4" aria-hidden="true" />}
          className="mt-2"
        >
          Try again
        </Button>
      ) : null}

      {requestId ? (
        <p className="mt-1 font-mono text-xs text-fg-muted">Reference {requestId}</p>
      ) : null}
    </div>
  );
}
