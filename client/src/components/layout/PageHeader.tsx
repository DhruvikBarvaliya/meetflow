import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface Breadcrumb {
  label: string;
  /** Omit on the current page — the last crumb is text, not a link. */
  to?: string;
}

export interface PageHeaderProps {
  title: string;
  description?: ReactNode;
  /** Primary and secondary actions for this page. */
  actions?: ReactNode;
  breadcrumbs?: Breadcrumb[];
  /** Filters or tabs that belong to the page rather than to its content. */
  children?: ReactNode;
  className?: string;
}

/**
 * The top of every page.
 *
 * Renders the only `<h1>` on the page, which is what lets a screen-reader user
 * jump straight to "where am I" after a route change.
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  children,
  className,
}: PageHeaderProps): JSX.Element {
  return (
    <header className={cn('flex flex-col gap-4', className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-fg-muted">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {index > 0 ? (
                    <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : null}
                  {crumb.to && !isLast ? (
                    <Link
                      to={crumb.to}
                      className="rounded-xs transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current={isLast ? 'page' : undefined} className="text-fg-secondary">
                      {crumb.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}

      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight text-fg sm:text-2xl">{title}</h1>
          {description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-fg-muted">{description}</p>
          ) : null}
        </div>

        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {children}
    </header>
  );
}
