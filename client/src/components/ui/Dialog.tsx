import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { useScrollLock } from '@/hooks/useScrollLock';
import { cn } from '@/lib/cn';
import { Button } from './Button';

const WIDTHS = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
} as const;

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: keyof typeof WIDTHS;
  /**
   * Leave false for anything the user could lose work in — a stray click on the
   * backdrop should not discard a half-filled form.
   */
  dismissOnBackdrop?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'md',
  dismissOnBackdrop = true,
}: DialogProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = description ? `${id}-description` : undefined;

  useFocusTrap(panelRef, open);
  useScrollLock(open);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="mf-animate-fade-in absolute inset-0 bg-overlay"
        // The backdrop is decorative; Escape and the close button are the real
        // affordances, so it is not exposed as a control.
        aria-hidden="true"
        onClick={dismissOnBackdrop ? onClose : undefined}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className={cn(
          'mf-animate-slide-up relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-surface shadow-xl sm:rounded-xl',
          WIDTHS[width],
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-fg">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-sm leading-relaxed text-fg-muted">
                {description}
              </p>
            ) : null}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="-mr-2 -mt-1 size-8 shrink-0"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>

        {children ? <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div> : null}

        {footer ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-sunken px-5 py-3">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `true` styles the confirm button as destructive. */
  destructive?: boolean;
  loading?: boolean;
}

/**
 * The gate in front of anything irreversible.
 *
 * The confirm button spells out the action ("Cancel appointment") rather than
 * saying "OK", because "Cancel / OK" on a cancellation dialog is genuinely
 * ambiguous about which button cancels what.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Keep',
  destructive = false,
  loading = false,
}: ConfirmDialogProps): JSX.Element {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      width="sm"
      dismissOnBackdrop={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-fg-secondary">{description}</p>
    </Dialog>
  );
}
