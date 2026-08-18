/**
 * The booking link's own questions, rendered as real form controls.
 *
 * The server type-checks each answer against the question that asked it
 * (`answerProblem()` in publicBooking.service.ts): NUMBER must arrive as a JSON
 * number, CHECKBOX as a boolean, MULTI_SELECT as an array of offered options.
 * An `<input>` yields strings for all of them, so coercion happens here, at the
 * point where the question's type is known, rather than being guessed at the
 * request boundary.
 */
import { useId } from 'react';
import { Checkbox, DatePicker, Field, Input, Select, Textarea } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { CustomQuestion } from '@/types/api';
import type { AnswerValue } from './publicApi';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors the server's notion of "no answer given". */
export function isAnswerEmpty(value: AnswerValue | undefined): boolean {
  if (value === undefined || value === null || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}

/**
 * Client-side mirror of the server's per-question checks, so a visitor is told
 * what is wrong before a round trip rather than after one.
 *
 * A required CHECKBOX is held to a stricter rule than the API's — the server
 * accepts an explicit `false`, but a required tick-box on a booking form is a
 * consent or a waiver, and treating "unticked" as a valid answer to it would
 * defeat the reason the business marked it required.
 */
export function validateAnswer(
  question: CustomQuestion,
  value: AnswerValue | undefined,
): string | null {
  if (question.type === 'CHECKBOX') {
    return question.required && value !== true ? `${question.label} is required.` : null;
  }

  if (isAnswerEmpty(value)) {
    return question.required ? `${question.label} is required.` : null;
  }

  switch (question.type) {
    case 'NUMBER':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `${question.label} must be a number.`;
    case 'EMAIL':
      return typeof value === 'string' && EMAIL_PATTERN.test(value)
        ? null
        : `${question.label} must be a valid email address.`;
    case 'URL':
      return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value)
        ? null
        : `${question.label} must be a link starting with http:// or https://.`;
    case 'SELECT':
      return typeof value === 'string' && (question.options ?? []).includes(value)
        ? null
        : `${question.label} must be one of the offered options.`;
    case 'MULTI_SELECT':
      return Array.isArray(value) && value.every((item) => (question.options ?? []).includes(item))
        ? null
        : `${question.label} contains an option that is not offered.`;
    default:
      return null;
  }
}

export interface QuestionFieldProps {
  question: CustomQuestion;
  value: AnswerValue | undefined;
  error?: string;
  timezone: string;
  onChange: (value: AnswerValue) => void;
}

export function QuestionField({
  question,
  value,
  error,
  timezone,
  onChange,
}: QuestionFieldProps): JSX.Element {
  const groupId = useId();
  const options = question.options ?? [];

  // A tick-box labels itself, so it takes the raw control rather than Field's
  // separate <label> — two labels for one input confuses a screen reader.
  if (question.type === 'CHECKBOX') {
    return (
      <Checkbox
        checked={value === true}
        onChange={(event) => onChange(event.target.checked)}
        label={
          <>
            {question.label}
            {question.required ? (
              <span className="ml-1 text-danger-text" aria-hidden>
                *
              </span>
            ) : null}
          </>
        }
        description={question.helpText}
        error={error}
        aria-required={question.required || undefined}
      />
    );
  }

  if (question.type === 'MULTI_SELECT') {
    const selected = Array.isArray(value) ? value : [];
    const errorId = `${groupId}-error`;

    return (
      <fieldset
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        aria-required={question.required || undefined}
      >
        <legend className="mb-1.5 text-sm font-medium text-fg">
          {question.label}
          {question.required ? (
            <span className="ml-1 text-danger-text" aria-hidden>
              *
            </span>
          ) : null}
          {question.required ? <span className="mf-sr-only"> (required)</span> : null}
        </legend>
        {question.helpText ? (
          <p className="mb-1.5 text-xs leading-relaxed text-fg-muted">{question.helpText}</p>
        ) : null}

        <div className={cn('flex flex-col gap-2')}>
          {options.map((option) => (
            <Checkbox
              key={option}
              label={option}
              checked={selected.includes(option)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, option]
                    : selected.filter((item) => item !== option),
                )
              }
            />
          ))}
        </div>

        {error ? (
          <p id={errorId} className="mt-1 text-xs font-medium text-danger-text" aria-live="polite">
            {error}
          </p>
        ) : null}
      </fieldset>
    );
  }

  return (
    <Field
      label={question.label}
      required={question.required}
      hint={question.helpText}
      error={error}
    >
      {(props) => {
        switch (question.type) {
          case 'SELECT':
            return (
              <Select
                {...props}
                value={typeof value === 'string' ? value : ''}
                placeholder="Choose one"
                options={options.map((option) => ({ value: option, label: option }))}
                onChange={(event) => onChange(event.target.value)}
              />
            );
          case 'TEXTAREA':
            return (
              <Textarea
                {...props}
                rows={3}
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => onChange(event.target.value)}
              />
            );
          case 'DATE':
            return (
              <DatePicker
                {...props}
                value={typeof value === 'string' && value !== '' ? value : null}
                timezone={timezone}
                onChange={onChange}
              />
            );
          case 'NUMBER':
            return (
              <Input
                {...props}
                type="number"
                inputMode="decimal"
                value={typeof value === 'number' ? String(value) : ''}
                onChange={(event) => {
                  const raw = event.target.value;
                  // An empty box is "no answer", not the number zero.
                  onChange(raw === '' ? '' : Number(raw));
                }}
              />
            );
          default: {
            const inputType =
              question.type === 'EMAIL'
                ? 'email'
                : question.type === 'PHONE'
                  ? 'tel'
                  : question.type === 'URL'
                    ? 'url'
                    : 'text';
            return (
              <Input
                {...props}
                type={inputType}
                inputMode={
                  question.type === 'EMAIL'
                    ? 'email'
                    : question.type === 'PHONE'
                      ? 'tel'
                      : undefined
                }
                value={typeof value === 'string' ? value : ''}
                onChange={(event) => onChange(event.target.value)}
              />
            );
          }
        }
      }}
    </Field>
  );
}
