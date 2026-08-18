import { browserTimezone, canonicalTimezone, formatZoneLabel, isValidTimezone } from './format';

/**
 * A short, real fallback list.
 *
 * Only used where `Intl.supportedValuesOf` is unavailable. These are genuine
 * IANA identifiers, not placeholders — an invalid zone would be rejected by the
 * server's `isValidTimezone` refinement.
 */
const FALLBACK_ZONES = [
  'Africa/Cairo',
  'Africa/Johannesburg',
  'Africa/Lagos',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Mexico_City',
  'America/New_York',
  'America/Sao_Paulo',
  'America/Toronto',
  'Asia/Bangkok',
  'Asia/Dubai',
  'Asia/Hong_Kong',
  'Asia/Jakarta',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Manila',
  'Asia/Riyadh',
  'Asia/Seoul',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Melbourne',
  'Australia/Perth',
  'Australia/Sydney',
  'Europe/Amsterdam',
  'Europe/Berlin',
  'Europe/Dublin',
  'Europe/Istanbul',
  'Europe/Lisbon',
  'Europe/London',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/Warsaw',
  'Europe/Zurich',
  'Pacific/Auckland',
  'UTC',
];

/**
 * `Intl.supportedValuesOf` is not in TypeScript's DOM lib for every target, so
 * it is reached through a narrow structural type rather than `any`.
 */
interface IntlWithSupportedValues {
  supportedValuesOf?: (key: 'timeZone') => string[];
}

let cachedZones: string[] | null = null;

/** Every IANA zone the browser knows, sorted, with the viewer's own zone first. */
export function listTimezones(): string[] {
  if (cachedZones) return cachedZones;

  const intl = Intl as unknown as IntlWithSupportedValues;
  const supported = intl.supportedValuesOf?.('timeZone');
  const raw = supported && supported.length > 0 ? supported : FALLBACK_ZONES;

  // Canonicalised and de-duplicated: some engines list both `Asia/Calcutta` and
  // `Asia/Kolkata`, which would otherwise appear twice and let the same zone be
  // stored under two different strings depending on which row was clicked.
  const zones = [...new Set(raw.map(canonicalTimezone))];

  const local = browserTimezone();
  if (isValidTimezone(local) && !zones.includes(local)) zones.push(local);

  zones.sort((a, b) => a.localeCompare(b));

  // The viewer's own zone is the answer nine times out of ten, so it goes first.
  const withoutLocal = zones.filter((zone) => zone !== local);
  cachedZones = isValidTimezone(local) ? [local, ...withoutLocal] : zones;
  return cachedZones;
}

export function timezoneOptions(): Array<{ value: string; label: string }> {
  return listTimezones().map((zone) => ({ value: zone, label: formatZoneLabel(zone) }));
}

/**
 * ISO 4217 codes MeetFlow offers by default.
 *
 * The API accepts any three-letter code, so this is a convenience list rather
 * than a restriction.
 */
export const CURRENCY_OPTIONS = [
  { value: 'INR', label: 'INR — Indian Rupee' },
  { value: 'USD', label: 'USD — US Dollar' },
  { value: 'EUR', label: 'EUR — Euro' },
  { value: 'GBP', label: 'GBP — Pound Sterling' },
  { value: 'AED', label: 'AED — UAE Dirham' },
  { value: 'AUD', label: 'AUD — Australian Dollar' },
  { value: 'CAD', label: 'CAD — Canadian Dollar' },
  { value: 'SGD', label: 'SGD — Singapore Dollar' },
  { value: 'ZAR', label: 'ZAR — South African Rand' },
  { value: 'JPY', label: 'JPY — Japanese Yen' },
] as const;
