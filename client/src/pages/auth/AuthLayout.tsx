import { Monitor, Moon, Sun } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useTheme } from '@/context/ThemeContext';
import { cn } from '@/lib/cn';

export interface AuthLayoutProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Sign-in / sign-up cross-link shown under the card. */
  footer?: ReactNode;
  /** Wider card for the workspace form, which has two columns. */
  width?: 'sm' | 'lg';
}

const THEME_CYCLE = [
  { mode: 'light', icon: Sun, label: 'Light' },
  { mode: 'dark', icon: Moon, label: 'Dark' },
  { mode: 'system', icon: Monitor, label: 'System' },
] as const;

/**
 * The frame for the unauthenticated pages.
 *
 * The theme control is repeated here rather than only in the app shell: someone
 * who prefers dark should not have to sign in through a white flash first.
 */
export function AuthLayout({
  title,
  description,
  children,
  footer,
  width = 'sm',
}: AuthLayoutProps): JSX.Element {
  const { mode, theme, cycleMode } = useTheme();
  const next = THEME_CYCLE.find((entry) => entry.mode === mode) ?? THEME_CYCLE[2];
  const Icon = theme === 'dark' ? Moon : Sun;

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <Link
          to="/login"
          className="flex items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <span
            className="flex size-7 items-center justify-center rounded-md bg-brand text-on-brand"
            aria-hidden="true"
          >
            <svg viewBox="0 0 16 16" className="size-4" fill="none">
              <rect
                x="2"
                y="3"
                width="12"
                height="11"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M2 6.5h12M5.5 2v2M10.5 2v2"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <circle cx="8" cy="10" r="1.25" fill="currentColor" />
            </svg>
          </span>
          <span className="text-base font-semibold tracking-tight text-fg">MeetFlow</span>
        </Link>

        <button
          type="button"
          onClick={cycleMode}
          aria-label={`Colour theme: ${next.label}. Change theme.`}
          className="flex size-9 items-center justify-center rounded-md text-fg-secondary transition-colors hover:bg-surface-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      </header>

      <main
        id="main-content"
        className="flex flex-1 items-start justify-center px-4 pb-16 pt-4 sm:items-center sm:pt-0"
      >
        <div className={cn('w-full', width === 'lg' ? 'max-w-2xl' : 'max-w-md')}>
          <div className="mb-6 flex flex-col gap-2 text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-fg">{title}</h1>
            {description ? (
              <p className="text-sm leading-relaxed text-fg-muted">{description}</p>
            ) : null}
          </div>

          <div className="rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
            {children}
          </div>

          {footer ? <div className="mt-5 text-center text-sm text-fg-muted">{footer}</div> : null}
        </div>
      </main>
    </div>
  );
}
