import { AlertCircle } from 'lucide-react';

/**
 * Form-level failure message.
 *
 * `role="alert"` so it is announced the moment it appears — a submission that
 * silently fails at the top of a scrolled form is otherwise invisible to anyone
 * not looking directly at it.
 */
export function FormBanner({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;

  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-md border border-danger-border bg-danger-subtle px-3.5 py-3 text-sm text-danger-text"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p className="leading-relaxed">{message}</p>
    </div>
  );
}
