/**
 * Notification template rendering, with the HTML escape as the point.
 *
 * These functions are the last thing that runs before a message becomes markup
 * in someone's inbox, and every value they interpolate — a customer's first
 * name, a cancellation reason, a business name — arrives from a public booking
 * form. The suite exists because the escape used to run one pass too late: the
 * body was substituted at enqueue time, and the escaping render at delivery
 * time found no placeholders left to escape, so `<img src=x onerror=...>` was
 * delivered live.
 *
 * Pure functions, so no database and no clock.
 */
import { describe, expect, it } from 'vitest';
import { renderTemplate, textToHtml } from '../../src/modules/notifications/templates';

/** The payload is irrelevant on the already-substituted path; name it so. */
const NO_PAYLOAD: Record<string, unknown> = {};

/** Strips the fixed wrapper so assertions read against the message itself. */
function body(html: string): string {
  const match = /^<div style="[^"]*">(.*)<\/div>$/s.exec(html);
  if (!match) throw new Error(`unexpected wrapper: ${html}`);
  return match[1] ?? '';
}

describe('textToHtml — already-substituted bodies (the delivery path)', () => {
  it('renders an injected script tag inert', () => {
    // Exactly what enqueueNotification stores when a public booking supplies
    // this as firstName: the value is already in the body, raw.
    const stored = 'Hi <img src=x onerror=alert(1)>,\n\nYour appointment is confirmed.';

    const html = textToHtml(stored, { firstName: '<img src=x onerror=alert(1)>' });

    // The payload survives as readable text, but no longer as a tag the mail
    // client will act on.
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(body(html)).toBe(
      '<p style="margin:0 0 8px">Hi &lt;img src=x onerror=alert(1)&gt;,</p>' +
        '<br/>' +
        '<p style="margin:0 0 8px">Your appointment is confirmed.</p>',
    );
  });

  it('escapes a closing tag that would otherwise break out of the wrapper', () => {
    const html = textToHtml('</div><script>alert(1)</script>', NO_PAYLOAD);

    expect(html).not.toContain('<script>');
    // The wrapper is still one element: nothing escaped its bounds.
    expect(body(html)).toBe(
      '<p style="margin:0 0 8px">&lt;/div&gt;&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });

  it('escapes all five characters that matter in HTML', () => {
    const html = textToHtml(`& < > " '`, NO_PAYLOAD);

    expect(body(html)).toBe('<p style="margin:0 0 8px">&amp; &lt; &gt; &quot; &#39;</p>');
  });

  it('does not double-escape an ampersand', () => {
    // The classic failure of "escape twice, just to be safe": a customer named
    // "Ben & Jerry" reads their own name as "Ben &amp; Jerry" in the email.
    const html = textToHtml('Ben & Jerry — 50% off & more', NO_PAYLOAD);

    expect(body(html)).toContain('Ben &amp; Jerry');
    expect(html).not.toContain('&amp;amp;');
  });

  it('does not re-escape text that already contains an entity', () => {
    // A stored body may legitimately hold the literal characters "&amp;" — for
    // instance a service named that way. It escapes to one entity, not two.
    const html = textToHtml('&amp;', NO_PAYLOAD);

    expect(body(html)).toBe('<p style="margin:0 0 8px">&amp;amp;</p>');
    expect(html).not.toContain('&amp;amp;amp;');
  });

  it('leaves plain prose untouched apart from the paragraph wrapping', () => {
    const stored = 'Hi Ada,\n\nYour Consultation is confirmed for 10:00.\n\n— Clinic';

    expect(body(textToHtml(stored, NO_PAYLOAD))).toBe(
      '<p style="margin:0 0 8px">Hi Ada,</p>' +
        '<br/>' +
        '<p style="margin:0 0 8px">Your Consultation is confirmed for 10:00.</p>' +
        '<br/>' +
        '<p style="margin:0 0 8px">— Clinic</p>',
    );
  });
});

describe('textToHtml — unrendered templates (the placeholder path)', () => {
  it('still substitutes placeholders after the escape pass', () => {
    // Escaping first must not consume the braces: `{{ }}` contains no character
    // escapeHtml touches, so the template survives to be rendered.
    const html = textToHtml('Hi {{ customerName }},\nSee you at {{startsAtLocal}}.', {
      customerName: 'Ada',
      startsAtLocal: '10:00',
    });

    expect(body(html)).toBe(
      '<p style="margin:0 0 8px">Hi Ada,</p><p style="margin:0 0 8px">See you at 10:00.</p>',
    );
  });

  it('escapes the values it substitutes', () => {
    const html = textToHtml('Hi {{customerName}}', {
      customerName: '<img src=x onerror=alert(1)>',
    });

    expect(html).not.toContain('<img');
    expect(body(html)).toBe('<p style="margin:0 0 8px">Hi &lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('escapes a substituted ampersand exactly once', () => {
    const html = textToHtml('Booked with {{businessName}}', { businessName: 'Ben & Jerry' });

    expect(body(html)).toBe('<p style="margin:0 0 8px">Booked with Ben &amp; Jerry</p>');
    expect(html).not.toContain('&amp;amp;');
  });

  it('renders a missing placeholder as empty rather than leaving it visible', () => {
    expect(body(textToHtml('Reason: {{reason}}', {}))).toBe(
      '<p style="margin:0 0 8px">Reason: </p>',
    );
  });
});

describe('renderTemplate', () => {
  it('substitutes raw by default — this is the plain-text branch', () => {
    // The stored body and the text part of the email must read as typed; the
    // escape belongs to the HTML projection alone.
    expect(renderTemplate('Hi {{customerName}}', { customerName: 'Ben & Jerry' })).toBe(
      'Hi Ben & Jerry',
    );
  });

  it('escapes only the values it substitutes, never the surrounding text', () => {
    // The property textToHtml depends on: a second pass cannot double-escape
    // text an earlier pass already escaped.
    expect(renderTemplate('a &amp; b {{x}}', { x: '<b>' }, { html: true })).toBe(
      'a &amp; b &lt;b&gt;',
    );
  });

  it('resolves dotted paths and stringifies non-strings', () => {
    expect(
      renderTemplate('{{appointment.durationMinutes}} minutes', {
        appointment: { durationMinutes: 30 },
      }),
    ).toBe('30 minutes');
  });
});
