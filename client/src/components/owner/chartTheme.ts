import { useEffect, useMemo, useState } from 'react';
import { useTheme } from '@/context/ThemeContext';

/**
 * Chart colours, resolved from the design tokens at runtime.
 *
 * Recharts writes `fill` and `stroke` as SVG presentation attributes, and a
 * `var(--token)` in a presentation attribute is not resolved by the browser —
 * the mark would simply render black. So the token values are read off the
 * document with `getComputedStyle` and handed to Recharts as literal colours,
 * and re-read whenever the resolved theme changes.
 *
 * This is the one place in the app that reads a token value rather than using
 * the utility class built from it, and it exists so charts stay part of the
 * same palette instead of hard-coding a second one.
 */

export interface ChartTheme {
  /**
   * Categorical slots, in fixed order.
   *
   * Assign by series identity, never by rank: if a filter removes a series the
   * survivors must keep their colours, or every reading of the chart resets.
   */
  series: readonly string[];
  /** Sequential ramp for magnitude, lowest to highest. */
  sequential: readonly string[];
  grid: string;
  axis: string;
  surface: string;
  border: string;
  /** Neutral fill for "the rest", so a 7th series never reuses slot 1. */
  muted: string;
}

const SERIES_TOKENS = [
  '--mf-chart-1',
  '--mf-chart-2',
  '--mf-chart-3',
  '--mf-chart-4',
  '--mf-chart-5',
  '--mf-chart-6',
] as const;

const SEQUENTIAL_TOKENS = [
  '--mf-chart-seq-1',
  '--mf-chart-seq-2',
  '--mf-chart-seq-3',
  '--mf-chart-seq-4',
  '--mf-chart-seq-5',
] as const;

function readTokens(names: readonly string[]): string[] {
  const styles = getComputedStyle(document.documentElement);
  return names.map((name) => styles.getPropertyValue(name).trim());
}

function readTheme(): ChartTheme {
  const [grid, axis, surface, border, muted] = readTokens([
    '--mf-chart-grid',
    '--mf-text-muted',
    '--mf-surface',
    '--mf-border',
    '--mf-border-strong',
  ]);

  return {
    series: readTokens(SERIES_TOKENS),
    sequential: readTokens(SEQUENTIAL_TOKENS),
    grid: grid ?? '',
    axis: axis ?? '',
    surface: surface ?? '',
    border: border ?? '',
    muted: muted ?? '',
  };
}

export function useChartTheme(): ChartTheme {
  const { theme } = useTheme();
  const [resolved, setResolved] = useState<ChartTheme>(() => readTheme());

  // `theme` flips the `data-theme` attribute in the same effect pass, so the
  // read has to happen after that commit rather than during render.
  useEffect(() => setResolved(readTheme()), [theme]);

  return resolved;
}

/**
 * A stable colour for a named entity.
 *
 * Charts that list staff or services get their slot from the entity's position
 * in the *unfiltered* reference list, so hiding one row does not repaint the
 * others. Past the sixth entity everything shares the neutral fill — a
 * generated seventh hue would not clear the separation floors.
 */
export function seriesColour(theme: ChartTheme, index: number): string {
  return theme.series[index] ?? theme.muted;
}

/** Buckets a 0..1 ratio onto the sequential ramp. */
export function sequentialColour(theme: ChartTheme, ratio: number): string {
  const steps = theme.sequential.length;
  if (steps === 0) return theme.muted;
  const clamped = Math.min(0.999_999, Math.max(0, ratio));
  return theme.sequential[Math.floor(clamped * steps)] ?? theme.muted;
}

/** Axis and label typography shared by every chart, so none drifts. */
export function useAxisStyle(theme: ChartTheme): {
  tick: { fill: string; fontSize: number };
  line: { stroke: string };
} {
  return useMemo(
    () => ({
      tick: { fill: theme.axis, fontSize: 12 },
      line: { stroke: theme.grid },
    }),
    [theme.axis, theme.grid],
  );
}
