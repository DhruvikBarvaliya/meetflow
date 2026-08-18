import { Check, Circle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PASSWORD_RULES } from './passwordSchema';

/**
 * Live feedback on the password rules.
 *
 * Every tick is computed from what the user has actually typed — this is a real
 * evaluation of the same rules the server enforces, not a decorative progress
 * bar. The list is `aria-live="polite"` so a screen-reader user hears rules
 * being satisfied instead of having to guess why submission keeps failing.
 */
export function PasswordChecklist({ value }: { value: string }): JSX.Element {
  return (
    <ul className="mt-1 grid gap-1 sm:grid-cols-2" aria-live="polite">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(value);
        return (
          <li
            key={rule.id}
            className={cn(
              'flex items-center gap-1.5 text-xs',
              met ? 'text-success-text' : 'text-fg-muted',
            )}
          >
            {met ? (
              <Check className="size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <Circle className="size-3.5 shrink-0" aria-hidden="true" />
            )}
            <span>
              {rule.label}
              <span className="mf-sr-only">{met ? ' — met' : ' — not yet met'}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
