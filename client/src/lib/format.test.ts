/**
 * The display helpers, which are where a bug is invisible in review and obvious
 * to a customer.
 *
 * Every function here turns API data into something a person reads, so a defect
 * does not throw — it prints. "Jane null" in a customer list, a ¥8,000 treatment
 * shown as ¥80, a 90-minute appointment described as "90 min" where the diary
 * says "1 hr 30 min". None of that fails a typecheck and none of it fails an
 * integration test, because the server was right and only the rendering was
 * wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  canonicalTimezone,
  customerName,
  formatDuration,
  formatMinuteOfDay,
  formatMoney,
  formatMoneyCompact,
  initialsOf,
} from './format';

describe('customerName', () => {
  it('never prints the word "null" at a customer', () => {
    // `lastName` is nullable throughout the API, and the obvious template
    // literal renders "Jane null" for every mononymous customer.
    expect(customerName({ firstName: 'Jane', lastName: null })).toBe('Jane');
    expect(customerName({ firstName: 'Jane', lastName: undefined })).toBe('Jane');
  });

  it('does not leave a trailing space when a surname is blank', () => {
    // An empty string is not null, so a filter on nullishness alone lets this
    // one through and the name is silently one character too long.
    expect(customerName({ firstName: 'Jane', lastName: '   ' })).toBe('Jane');
  });

  it('falls back rather than rendering an empty cell', () => {
    // A blank cell in a table reads as a broken row; a named fallback reads as
    // a record with a missing field, which is what it is.
    expect(customerName(null)).toBe('Unknown customer');
    expect(customerName({ firstName: '', lastName: '' })).toBe('Unknown customer');
    expect(customerName(undefined, 'Walk-in')).toBe('Walk-in');
  });

  it('joins both parts when both are there', () => {
    expect(customerName({ firstName: ' Priya ', lastName: ' Shah ' })).toBe('Priya Shah');
  });
});

describe('formatMoney', () => {
  it('reads minor units, because that is what every money field on the API is', () => {
    // 350000 paise is ₹3,500.00. Rendering the stored integer directly would
    // overstate every price on the booking page by a hundredfold.
    expect(formatMoney(350_000, 'INR')).toContain('3,500.00');
  });

  it('asks Intl for the currency exponent instead of assuming 100', () => {
    // JPY has no minor unit. Dividing by a hard-coded 100 turns a ¥8,000
    // treatment into ¥80 — an under-report, so nothing looks alarming.
    expect(formatMoney(8_000, 'JPY', 'en-US')).toBe('¥8,000');
    expect(formatMoney(8_000, 'KRW', 'en-US')).toBe('₩8,000');
  });

  it('renders an unrecognised but well-formed code through Intl', () => {
    // `Intl` accepts any three-letter code and prints it in place of a symbol,
    // so this does not reach the fallback — it is a formatted amount with the
    // code as its unit, which is the right thing to show for a currency the
    // runtime has no symbol for.
    //
    // The separator is a non-breaking space, written as an escape because the
    // literal character is indistinguishable from a plain space in a diff and
    // produces a failure that reads `expected 'ZZZ 3,500.00' to be
    // 'ZZZ 3,500.00'`. Anything asserting against `Intl` output has to account
    // for it.
    expect(formatMoney(350_000, 'ZZZ')).toBe('ZZZ 3,500.00');
  });

  it('falls back to a plain number rather than taking a pricing table down', () => {
    // A malformed code is what actually throws. The catch branch exists so one
    // bad row cannot blank an entire services list.
    const rendered = formatMoney(350_000, 'not-a-currency');
    expect(rendered).toContain('not-a-currency');
    expect(rendered).toContain('3500.00');
  });

  it('shows a dash rather than NaN for a missing figure', () => {
    expect(formatMoney(Number.NaN, 'INR')).toBe('—');
    expect(formatMoney(Number.POSITIVE_INFINITY, 'INR')).toBe('—');
  });
});

describe('formatMoneyCompact', () => {
  it('drops the decimals only when there are none to lose', () => {
    expect(formatMoneyCompact(350_000, 'INR')).not.toContain('.00');
    expect(formatMoneyCompact(350_050, 'INR')).toContain('.50');
  });

  it('applies the same currency exponent as the full form', () => {
    expect(formatMoneyCompact(8_000, 'JPY', 'en-US')).toBe('¥8,000');
  });
});

describe('formatDuration', () => {
  it('speaks in hours once there is an hour to speak of', () => {
    expect(formatDuration(45)).toBe('45 min');
    expect(formatDuration(60)).toBe('1 hr');
    expect(formatDuration(90)).toBe('1 hr 30 min');
    expect(formatDuration(150)).toBe('2 hr 30 min');
  });

  it('refuses to render a negative or absent duration as one', () => {
    expect(formatDuration(0)).toBe('0 min');
    expect(formatDuration(-30)).toBe('0 min');
    expect(formatDuration(Number.NaN)).toBe('0 min');
  });
});

describe('formatMinuteOfDay', () => {
  it('renders working-hours rows, which the API stores as minutes past midnight', () => {
    expect(formatMinuteOfDay(0)).toBe('12:00 am');
    expect(formatMinuteOfDay(600)).toBe('10:00 am');
    expect(formatMinuteOfDay(750)).toBe('12:30 pm');
    expect(formatMinuteOfDay(1_439)).toBe('11:59 pm');
  });

  it('clamps rather than wrapping past midnight', () => {
    // 1440 is the exclusive end of a day. Wrapping it to 12:00 am would show a
    // shift that ends at midnight as one that ends before it started.
    expect(formatMinuteOfDay(1_440)).toBe('11:59 pm');
    expect(formatMinuteOfDay(-10)).toBe('12:00 am');
  });
});

describe('canonicalTimezone', () => {
  it('collapses the aliases a browser still reports', () => {
    // A zone selector that lists both Asia/Calcutta and Asia/Kolkata offers the
    // same zone twice and matches the stored one neither time.
    expect(canonicalTimezone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(canonicalTimezone('Europe/Kiev')).toBe('Europe/Kyiv');
    expect(canonicalTimezone('America/Buenos_Aires')).toBe('America/Argentina/Buenos_Aires');
  });

  it('passes an unknown zone through untouched', () => {
    // The alias table is a correction, not an allow-list: a zone added to the
    // IANA database after this shipped must still work.
    expect(canonicalTimezone('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(canonicalTimezone('Mars/Olympus_Mons')).toBe('Mars/Olympus_Mons');
  });
});

describe('initialsOf', () => {
  it('stops at two letters so an avatar cannot overflow', () => {
    expect(initialsOf('Priya', 'Shah')).toBe('PS');
    expect(initialsOf('Maria del Carmen', 'Garcia Lopez')).toBe('MD');
  });

  it('has something to show for a record with nothing in it', () => {
    expect(initialsOf(null, undefined, '   ')).toBe('?');
  });
});
