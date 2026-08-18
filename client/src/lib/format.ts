import { DateTime, Duration, Interval, Settings } from 'luxon';

/**
 * Presentation-layer formatting.
 *
 * Every function takes an explicit IANA zone. That is the whole point of this
 * module: a scheduling product has at least three clocks in play at once — the
 * workspace's, the location's and the viewer's — and rendering in whichever one
 * the browser happens to sit in is how a 9am appointment shows up at 3:30am.
 * Callers pass the zone that the value *means*, usually
 * `workspace.timezone` or `appointment.timezone`.
 */

// Pinned rather than assumed. Luxon already defaults to this, but a global flip
// elsewhere would turn one malformed timestamp in one record into a thrown
// error three components away instead of a single "—" in a cell.
Settings.throwOnInvalid = false;

/**
 * Legacy IANA zone names that browsers still report, mapped to the canonical
 * identifier the rest of MeetFlow uses.
 *
 * These are genuine aliases — `Asia/Calcutta` and `Asia/Kolkata` are the same
 * zone — but they are different *strings*, and Chrome reports the old one even
 * when asked for the new. Left uncanonicalised, a workspace created in Chrome
 * is stored as `Asia/Calcutta` while its booking links, seeds and reports all
 * say `Asia/Kolkata`, and every `zone === 'Asia/Kolkata'` comparison silently
 * fails.
 */
const ZONE_ALIASES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Asia/Thimbu': 'Asia/Thimphu',
  'Africa/Asmera': 'Africa/Asmara',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'America/Godthab': 'America/Nuuk',
  'Atlantic/Faeroe': 'Atlantic/Faroe',
  'Europe/Kiev': 'Europe/Kyiv',
  'Pacific/Ponape': 'Pacific/Pohnpei',
  'Pacific/Truk': 'Pacific/Chuuk',
};

/** Canonical form of an IANA identifier. Unknown zones pass through unchanged. */
export function canonicalTimezone(zone: string): string {
  return ZONE_ALIASES[zone] ?? zone;
}

/** The viewer's own zone, canonicalised, for "times are shown in …" disclosures. */
export function browserTimezone(): string {
  return canonicalTimezone(DateTime.local().zoneName ?? 'UTC');
}

export function isValidTimezone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

function toDateTime(value: string | Date | DateTime, zone: string): DateTime {
  if (DateTime.isDateTime(value)) return value.setZone(zone);
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone });
  // Instants carry an offset; bare `YYYY-MM-DD` calendar dates do not and must
  // be read *in* the target zone rather than converted into it.
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? DateTime.fromISO(value, { zone })
    : DateTime.fromISO(value, { setZone: false }).setZone(zone);
}

// ---------------------------------------------------------------------------
// Dates and times
// ---------------------------------------------------------------------------

/** `22 Jun 2026` */
export function formatDate(value: string | Date | DateTime, zone: string, locale?: string): string {
  const dt = toDateTime(value, zone);
  return dt.isValid ? dt.setLocale(locale ?? dt.locale ?? 'en').toFormat('d LLL yyyy') : '—';
}

/** `Mon, 22 June 2026` — for headings where the weekday carries meaning. */
export function formatDateLong(
  value: string | Date | DateTime,
  zone: string,
  locale?: string,
): string {
  const dt = toDateTime(value, zone);
  return dt.isValid ? dt.setLocale(locale ?? dt.locale ?? 'en').toFormat('ccc, d LLLL yyyy') : '—';
}

/** `10:00 am` */
export function formatTime(value: string | Date | DateTime, zone: string, locale?: string): string {
  const dt = toDateTime(value, zone);
  return dt.isValid
    ? dt
        .setLocale(locale ?? dt.locale ?? 'en')
        .toFormat('h:mm a')
        .toLowerCase()
    : '—';
}

/** `22 Jun 2026, 10:00 am` */
export function formatDateTime(
  value: string | Date | DateTime,
  zone: string,
  locale?: string,
): string {
  const dt = toDateTime(value, zone);
  if (!dt.isValid) return '—';
  return `${formatDate(dt, zone, locale)}, ${formatTime(dt, zone, locale)}`;
}

/** `10:00 am – 11:30 am`, collapsing the meridiem when both halves share one. */
export function formatTimeRange(
  start: string | Date | DateTime,
  end: string | Date | DateTime,
  zone: string,
  locale?: string,
): string {
  const from = toDateTime(start, zone);
  const to = toDateTime(end, zone);
  if (!from.isValid || !to.isValid) return '—';

  const sameMeridiem = from.toFormat('a') === to.toFormat('a');
  const left = sameMeridiem
    ? from.setLocale(locale ?? 'en').toFormat('h:mm')
    : formatTime(from, zone, locale);
  return `${left} – ${formatTime(to, zone, locale)}`;
}

/** `Today`, `Tomorrow`, `Yesterday`, else `Mon 22 Jun`. */
export function formatDayLabel(
  value: string | Date | DateTime,
  zone: string,
  locale?: string,
): string {
  const dt = toDateTime(value, zone).startOf('day');
  if (!dt.isValid) return '—';

  const today = DateTime.now().setZone(zone).startOf('day');
  const diff = Math.round(dt.diff(today, 'days').days);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';

  const showYear = dt.year !== today.year;
  return dt.setLocale(locale ?? 'en').toFormat(showYear ? 'ccc d LLL yyyy' : 'ccc d LLL');
}

/** `in 2 hours`, `3 days ago`. Falls back to an absolute date beyond a month. */
export function formatRelative(value: string | Date | DateTime, zone: string): string {
  const dt = toDateTime(value, zone);
  if (!dt.isValid) return '—';
  if (Math.abs(dt.diffNow('days').days) > 30) return formatDate(dt, zone);
  return dt.toRelative({ base: DateTime.now().setZone(zone) }) ?? '—';
}

/** The `YYYY-MM-DD` a date-only API field expects, resolved in `zone`. */
export function toIsoDate(value: string | Date | DateTime, zone: string): string {
  const dt = toDateTime(value, zone);
  return dt.isValid ? (dt.toISODate() ?? '') : '';
}

/** The offset-bearing instant every appointment endpoint requires. */
export function toIsoInstant(value: string | Date | DateTime, zone: string): string {
  const dt = toDateTime(value, zone);
  return dt.isValid ? (dt.toISO() ?? '') : '';
}

/** `GMT+5:30` — used next to a time whenever two zones are in play. */
export function formatZoneOffset(zone: string, at?: string | Date | DateTime): string {
  const dt = at ? toDateTime(at, zone) : DateTime.now().setZone(zone);
  return dt.isValid ? dt.toFormat('ZZZZ') : '';
}

/** `Asia/Kolkata` → `Asia / Kolkata (GMT+5:30)`, for timezone pickers. */
export function formatZoneLabel(zone: string): string {
  const dt = DateTime.now().setZone(zone);
  const readable = zone.replace(/_/g, ' ').replace('/', ' / ');
  return dt.isValid ? `${readable} (${dt.toFormat('ZZZZ')})` : readable;
}

/** Whether two instants fall on the same calendar day *in `zone`*. */
export function isSameDay(
  a: string | Date | DateTime,
  b: string | Date | DateTime,
  zone: string,
): boolean {
  return toDateTime(a, zone).hasSame(toDateTime(b, zone), 'day');
}

/** Inclusive list of `YYYY-MM-DD` dates spanning a range, for calendar grids. */
export function eachDayInRange(from: string, to: string, zone: string): string[] {
  const start = toDateTime(from, zone).startOf('day');
  const end = toDateTime(to, zone).endOf('day');
  if (!start.isValid || !end.isValid || end < start) return [];
  return Interval.fromDateTimes(start, end)
    .splitBy({ days: 1 })
    .map((interval) => interval.start?.toISODate() ?? '')
    .filter((date) => date !== '');
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/** `45 min`, `1 hr`, `1 hr 30 min`. */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0 min';
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} hr`;
  return `${hours} hr ${rest} min`;
}

/** `1:30` — the compact form for dense table cells. */
export function formatDurationCompact(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0:00';
  return Duration.fromObject({ minutes: Math.round(minutes) }).toFormat('h:mm');
}

/** Minutes past local midnight (`600`) as a clock time (`10:00 am`). */
export function formatMinuteOfDay(minuteOfDay: number, locale?: string): string {
  const clamped = Math.max(0, Math.min(1439, Math.round(minuteOfDay)));
  return DateTime.fromObject({ hour: Math.floor(clamped / 60), minute: clamped % 60 })
    .setLocale(locale ?? 'en')
    .toFormat('h:mm a')
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Numbers and money
// ---------------------------------------------------------------------------

/**
 * How many minor units make one major unit of a currency.
 *
 * Asked of `Intl` rather than assumed to be 100: JPY and KRW have none, and
 * dividing their amounts by 100 would under-report revenue a hundredfold.
 */
function minorUnitFactor(currency: string, locale: string): number {
  try {
    const { maximumFractionDigits } = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
    }).resolvedOptions();
    // Two decimals is the overwhelming default, and the right guess when a
    // runtime declines to report the currency's exponent.
    return 10 ** (maximumFractionDigits ?? 2);
  } catch {
    return 100;
  }
}

/**
 * Formats an integer amount of **minor units** (`350000` INR → `₹3,500.00`).
 *
 * Every money field on this API is minor units, so this is the only correct way
 * to render one.
 */
export function formatMoney(minorUnits: number, currency: string, locale = 'en-IN'): string {
  if (!Number.isFinite(minorUnits)) return '—';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
      minorUnits / minorUnitFactor(currency, locale),
    );
  } catch {
    // An unknown ISO code must still render a readable number, not crash a table.
    return `${currency} ${(minorUnits / 100).toFixed(2)}`;
  }
}

/** Drops the decimals when the amount is whole — for headline figures. */
export function formatMoneyCompact(minorUnits: number, currency: string, locale = 'en-IN'): string {
  if (!Number.isFinite(minorUnits)) return '—';
  const factor = minorUnitFactor(currency, locale);
  const major = minorUnits / factor;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(major) ? 0 : 2,
    }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}

export function formatNumber(value: number, locale = 'en-IN'): string {
  return Number.isFinite(value) ? new Intl.NumberFormat(locale).format(value) : '—';
}

/**
 * A 0..1 ratio as a percentage (`0.1818` → `18.2%`).
 *
 * The analytics endpoints return ratios, not percentages; multiplying here
 * rather than at each call site is what stops one panel showing `0.18%`.
 */
export function formatRatioAsPercent(ratio: number, fractionDigits = 1, locale = 'en-IN'): string {
  if (!Number.isFinite(ratio)) return '—';
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(ratio);
}

/** `Priya Shah` → `PS`. Two letters at most, so an avatar never overflows. */
export function initialsOf(...parts: Array<string | null | undefined>): string {
  const letters = parts
    .flatMap((part) => (part ?? '').trim().split(/\s+/))
    .filter((word) => word.length > 0)
    .map((word) => word[0]?.toUpperCase() ?? '');
  return letters.slice(0, 2).join('') || '?';
}

/** Title-cases a SCREAMING_SNAKE enum for display (`NO_SHOW` → `No show`). */
export function humanizeEnum(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
