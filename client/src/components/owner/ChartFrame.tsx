import { BarChart3 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardBody, CardHeader, ErrorState, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';

export interface ChartFrameProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Height of the plot area. Charts inside are 100% of it. */
  height?: number;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  /** True when the request succeeded and returned nothing to plot. */
  isEmpty: boolean;
  emptyMessage: string;
  /** Named series, drawn as the legend. Omit for a single-series chart. */
  legend?: Array<{ label: string; colour: string }>;
  /** A screen-reader summary of what the plot shows. */
  summary?: string;
  children: ReactNode;
  className?: string;
}

/**
 * The frame every chart on the management surface sits in.
 *
 * It owns the four states a chart can be in — loading, failed, empty, drawn —
 * so no page reinvents them, and so an empty chart is never mistaken for a
 * chart full of zeros. That distinction matters here more than most places: a
 * clinic with no bookings this week and a clinic whose analytics call failed
 * must not look the same.
 *
 * The legend lives in the frame rather than inside the plot because a legend
 * drawn by the chart library is not reachable by keyboard and re-flows badly on
 * a phone.
 */
export function ChartFrame({
  title,
  description,
  actions,
  height = 260,
  isLoading,
  error,
  onRetry,
  isEmpty,
  emptyMessage,
  legend,
  summary,
  children,
  className,
}: ChartFrameProps): JSX.Element {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader title={title} description={description} actions={actions} />

      {legend && legend.length > 0 && !isLoading && !error && !isEmpty ? (
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 pt-3">
          {legend.map((entry) => (
            <li key={entry.label} className="flex items-center gap-1.5 text-xs text-fg-secondary">
              <span
                aria-hidden="true"
                className="size-2.5 shrink-0 rounded-xs"
                style={{ backgroundColor: entry.colour }}
              />
              {entry.label}
            </li>
          ))}
        </ul>
      ) : null}

      <CardBody className="flex-1">
        {isLoading ? (
          <div style={{ height }} className="flex flex-col justify-end gap-2" aria-hidden="true">
            <Skeleton className="h-1/3 w-full" />
            <Skeleton className="h-1/2 w-full" />
            <Skeleton className="h-3 w-24" />
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} className="py-8" />
        ) : isEmpty ? (
          <div
            style={{ minHeight: height }}
            className="flex flex-col items-center justify-center gap-2 text-center"
          >
            <span
              className="flex size-10 items-center justify-center rounded-full bg-surface-sunken text-fg-muted"
              aria-hidden="true"
            >
              <BarChart3 className="size-5" />
            </span>
            <p className="max-w-sm text-sm text-fg-muted">{emptyMessage}</p>
          </div>
        ) : (
          <figure className="m-0" style={{ height }}>
            {summary ? <figcaption className="mf-sr-only">{summary}</figcaption> : null}
            {children}
          </figure>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * What Recharts hands a custom tooltip.
 *
 * Declared locally rather than imported from `recharts/types/*`: those paths
 * are internal and have moved between minor versions, and every field this
 * component reads is part of the documented contract.
 */
export interface ChartTooltipPayloadEntry {
  name?: string | number;
  value?: string | number | Array<string | number>;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: ChartTooltipPayloadEntry[];
  /** Renders the value; receives the series key so units can differ per series. */
  formatValue?: (value: number, dataKey: string) => string;
  /** Renders the heading; the raw category value is passed through. */
  formatLabel?: (label: string) => string;
}

/** The hover layer. Every chart in this app ships one. */
export function ChartTooltip({
  active,
  label,
  payload,
  formatValue,
  formatLabel,
}: ChartTooltipProps): JSX.Element | null {
  if (active !== true || !payload || payload.length === 0) return null;

  const heading = label === undefined ? '' : String(label);

  return (
    <div className="pointer-events-none rounded-md border border-border bg-surface px-3 py-2 shadow-md">
      {heading ? (
        <p className="mb-1 text-xs font-semibold text-fg">
          {formatLabel ? formatLabel(heading) : heading}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {payload.map((entry, index) => {
          const numeric = typeof entry.value === 'number' ? entry.value : Number(entry.value);
          const key = String(entry.dataKey ?? entry.name ?? index);
          return (
            <li key={key} className="flex items-center gap-2 text-xs">
              <span
                aria-hidden="true"
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-fg-muted">{entry.name}</span>
              <span className="ml-auto font-medium tabular-nums text-fg">
                {Number.isFinite(numeric)
                  ? formatValue
                    ? formatValue(numeric, key)
                    : String(numeric)
                  : '—'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
