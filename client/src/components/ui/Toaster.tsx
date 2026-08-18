import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** Milliseconds on screen. Pass 0 to require an explicit dismissal. */
  duration?: number;
}

interface Toast extends Required<Omit<ToastOptions, 'description'>> {
  id: number;
  description?: string;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_STYLES: Record<ToastTone, { icon: JSX.Element; accent: string }> = {
  success: {
    icon: <CheckCircle2 className="size-5 text-success-text" aria-hidden="true" />,
    accent: 'border-l-success',
  },
  error: {
    icon: <AlertCircle className="size-5 text-danger-text" aria-hidden="true" />,
    accent: 'border-l-danger',
  },
  warning: {
    icon: <TriangleAlert className="size-5 text-warning-text" aria-hidden="true" />,
    accent: 'border-l-warning',
  },
  info: {
    icon: <Info className="size-5 text-info-text" aria-hidden="true" />,
    accent: 'border-l-info',
  },
};

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = (nextId += 1);
      const tone = options.tone ?? 'info';
      // Errors stay until dismissed by default: they usually carry an
      // instruction, and five seconds is not long enough to read and act on one.
      const duration = options.duration ?? (tone === 'error' ? 0 : 5000);

      // Resolved values last: `options.tone` may be undefined and would
      // otherwise overwrite the default that was just computed from it.
      setToasts((current) => [...current, { ...options, id, tone, duration }]);

      if (duration > 0) {
        timersRef.current.set(
          id,
          window.setTimeout(() => dismiss(id), duration),
        );
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

/**
 * The live region.
 *
 * Two regions rather than one: `assertive` interrupts for failures, which the
 * user must hear before they carry on, while successes go into a `polite`
 * region so a confirmation never cuts across what someone is reading.
 */
function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}): JSX.Element {
  const urgent = toasts.filter((entry) => entry.tone === 'error' || entry.tone === 'warning');
  const calm = toasts.filter((entry) => entry.tone !== 'error' && entry.tone !== 'warning');

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:top-0 sm:items-end">
      <div role="alert" aria-live="assertive" className="contents">
        {urgent.map((entry) => (
          <ToastCard key={entry.id} toast={entry} onDismiss={onDismiss} />
        ))}
      </div>
      <div role="status" aria-live="polite" className="contents">
        {calm.map((entry) => (
          <ToastCard key={entry.id} toast={entry} onDismiss={onDismiss} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: number) => void;
}): JSX.Element {
  const tone = TONE_STYLES[toast.tone];
  return (
    <div
      className={cn(
        'mf-animate-slide-up pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border border-l-4 border-border bg-surface p-3.5 shadow-lg',
        tone.accent,
      )}
    >
      <span className="mt-0.5 shrink-0">{tone.icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-sm font-semibold text-fg">{toast.title}</p>
        {toast.description ? (
          <p className="text-sm leading-relaxed text-fg-muted">{toast.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label={`Dismiss: ${toast.title}`}
        className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside <ToastProvider>.');
  return context;
}
