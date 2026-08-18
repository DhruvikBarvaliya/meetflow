/**
 * Chrome shared by the public booking flow and the manage page.
 *
 * These pages are the only part of MeetFlow a business's own customers see, so
 * they carry the *business's* identity. MeetFlow appears once, small, in the
 * footer.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Globe } from 'lucide-react';
import { Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import { formatZoneLabel } from '@/lib/format';
import { timezoneOptions } from '@/lib/timezones';
import type { PublicBusiness } from '@/types/api';

type ShellBusiness = Pick<PublicBusiness, 'name' | 'logoUrl' | 'supportEmail' | 'supportPhone'>;

export interface PublicShellProps {
  business: ShellBusiness | null;
  /** Accent from the link's branding, when the business has set one. */
  accentColor?: string | null;
  timezone?: string;
  onTimezoneChange?: (zone: string) => void;
  children: ReactNode;
}

export function PublicShell({
  business,
  accentColor,
  timezone,
  onTimezoneChange,
  children,
}: PublicShellProps) {
  // Branding overrides the brand token for this subtree only, so every
  // token-driven component picks it up without prop drilling a colour.
  const brandOverride = accentColor
    ? ({ '--mf-brand': accentColor, '--mf-brand-hover': accentColor } as CSSProperties)
    : undefined;

  return (
    <div className="min-h-dvh bg-surface-sunken text-fg" style={brandOverride}>
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-4 py-4 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {business?.logoUrl ? (
              <img
                src={business.logoUrl}
                alt=""
                className="h-10 w-10 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <div
                aria-hidden
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand-subtle text-sm font-semibold text-brand-text"
              >
                {business?.name?.slice(0, 2).toUpperCase() ?? '··'}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-base font-semibold">{business?.name ?? 'Booking'}</p>
              {business?.supportEmail ? (
                <a
                  href={`mailto:${business.supportEmail}`}
                  className="truncate text-sm text-fg-muted hover:text-brand-text"
                >
                  {business.supportEmail}
                </a>
              ) : null}
            </div>
          </div>

          {timezone && onTimezoneChange ? (
            <div className="flex items-center gap-2">
              <Globe aria-hidden className="h-4 w-4 text-fg-muted" />
              <Select
                value={timezone}
                onChange={(event) => onTimezoneChange(event.target.value)}
                options={timezoneOptions()}
                selectSize="sm"
                aria-label="Time zone for the times shown on this page"
                className="min-w-[12rem]"
              />
            </div>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-6 sm:px-6 sm:py-10">{children}</main>

      <footer className="mx-auto max-w-3xl px-4 pb-10 text-center text-xs text-fg-muted sm:px-6">
        {timezone ? <p className="mb-1">All times shown in {formatZoneLabel(timezone)}.</p> : null}
        <p>Scheduling by MeetFlow</p>
      </footer>
    </div>
  );
}

export interface StepperProps {
  steps: Array<{ id: string; label: string }>;
  currentIndex: number;
  onStepSelect?: (index: number) => void;
}

/**
 * Progress indicator.
 *
 * Completed steps are real buttons so a visitor can go back and change an
 * earlier answer. Future steps are not, because reaching them out of order
 * would skip the validation in between.
 */
export function Stepper({ steps, currentIndex, onStepSelect }: StepperProps) {
  return (
    <nav aria-label="Booking progress" className="mb-6">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs sm:text-sm">
        {steps.map((step, index) => {
          const isComplete = index < currentIndex;
          const isCurrent = index === currentIndex;

          const content = (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1',
                isCurrent && 'bg-brand-subtle font-medium text-brand-text',
                isComplete && 'text-fg-secondary',
                !isCurrent && !isComplete && 'text-fg-muted',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'grid h-5 w-5 place-items-center rounded-full border text-[0.6875rem]',
                  isCurrent && 'border-brand bg-brand text-on-brand',
                  isComplete && 'border-brand text-brand-text',
                  !isCurrent && !isComplete && 'border-border',
                )}
              >
                {index + 1}
              </span>
              {step.label}
            </span>
          );

          return (
            <li key={step.id} className="flex items-center">
              {isComplete && onStepSelect ? (
                <button
                  type="button"
                  onClick={() => onStepSelect(index)}
                  className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {content}
                </button>
              ) : (
                <span aria-current={isCurrent ? 'step' : undefined}>{content}</span>
              )}
              {index < steps.length - 1 ? (
                <span aria-hidden className="px-0.5 text-fg-muted">
                  ›
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
