/**
 * CSV encoding for report exports.
 *
 * Two separate problems, both of which have bitten real products:
 *
 *  1. **Delimiter collision (RFC 4180).** A customer called `O'Brien, Jr.` or a
 *     cancellation reason containing a newline must not shift every column to
 *     its right. A field containing a quote, a comma or a line break is wrapped
 *     in quotes, and any quote inside it is doubled.
 *  2. **Formula injection.** Excel, LibreOffice and Google Sheets evaluate a
 *     cell whose text begins with `=`, `+`, `-` or `@` as a formula. Free text
 *     in this export is written by customers, so a booking note reading
 *     `=HYPERLINK("http://evil","click")` would become live content in an
 *     operator's spreadsheet. Prefixing with an apostrophe keeps such a cell
 *     literal; the apostrophe is not displayed by the spreadsheet.
 *
 * Only strings are hardened. Numbers are produced by this codebase from integer
 * columns, so `-` can never be the start of an attack, and quoting them would
 * make every numeric column import as text.
 */

/** RFC 4180 says CRLF; Excel on Windows is the reason to keep it. */
export const CSV_LINE_BREAK = '\r\n';

/**
 * Byte-order mark.
 *
 * Without it Excel reads a UTF-8 file as the system codepage and mangles every
 * non-ASCII name in the export; other readers skip it silently. Built from its
 * code point rather than pasted in, because the character itself is invisible
 * in an editor and one stray whitespace-trimming tool would silently delete it.
 */
export const CSV_BOM = String.fromCharCode(0xfeff);

const NEEDS_QUOTING = /["\r\n,]/;
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return String(value);

  const guarded = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export function csvLine(values: ReadonlyArray<string | number | null | undefined>): string {
  return `${values.map(csvField).join(',')}${CSV_LINE_BREAK}`;
}

/**
 * A filename safe to place in a `Content-Disposition` header.
 *
 * The header is parsed by the browser, so a quote or a newline reaching it is a
 * header-injection bug rather than a cosmetic one. Everything outside a
 * conservative allowlist is replaced instead of removed, so two distinct
 * requests cannot collapse into the same suggested name.
 */
export function safeFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'export.csv';
}
