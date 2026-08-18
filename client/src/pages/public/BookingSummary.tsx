/**
 * What the visitor is about to book, or has just booked.
 *
 * Price and duration are read from the chosen slot rather than from the service
 * record: the availability engine returns the effective figures for that
 * particular opening, which is what will actually be charged.
 */
import { Card, CardBody } from '@/components/ui';
import { formatDateLong, formatDuration, formatMoney, formatTimeRange } from '@/lib/format';
import type { CustomQuestion, PublicSlot } from '@/types/api';
import type { AnswerValue } from './publicApi';
import { isAnswerEmpty } from './QuestionField';

export interface BookingSummaryProps {
  serviceName: string;
  slot: PublicSlot;
  timezone: string;
  locationName: string | null;
  locationAddress: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  notes: string | null;
  questions: CustomQuestion[];
  answers: Record<string, AnswerValue>;
}

function renderAnswer(value: AnswerValue): string {
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function BookingSummary({
  serviceName,
  slot,
  timezone,
  locationName,
  locationAddress,
  customerName,
  customerEmail,
  customerPhone,
  notes,
  questions,
  answers,
}: BookingSummaryProps): JSX.Element {
  const answered = questions.filter((question) => !isAnswerEmpty(answers[question.key]));

  return (
    <Card>
      <CardBody className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="font-medium">{serviceName}</p>
            <p className="text-sm text-fg-muted">{formatDuration(slot.durationMinutes)}</p>
          </div>
          <p className="shrink-0 font-medium">{formatMoney(slot.priceAmount, slot.currency)}</p>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-fg-muted">When</dt>
            <dd className="font-medium">
              {formatDateLong(slot.startsAt, timezone)}
              <br />
              {formatTimeRange(slot.startsAt, slot.endsAt, timezone)}
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">With</dt>
            <dd className="font-medium">{slot.staffName}</dd>
          </div>
          {locationName ? (
            <div>
              <dt className="text-fg-muted">Where</dt>
              <dd className="font-medium">
                {locationName}
                {locationAddress ? (
                  <span className="block font-normal text-fg-muted">{locationAddress}</span>
                ) : null}
              </dd>
            </div>
          ) : null}
          <div>
            <dt className="text-fg-muted">Booked for</dt>
            <dd className="font-medium">
              {customerName}
              <span className="block font-normal text-fg-muted">{customerEmail}</span>
              {customerPhone ? (
                <span className="block font-normal text-fg-muted">{customerPhone}</span>
              ) : null}
            </dd>
          </div>
        </dl>

        {answered.length > 0 ? (
          <dl className="grid gap-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
            {answered.map((question) => (
              <div key={question.key}>
                <dt className="text-fg-muted">{question.label}</dt>
                <dd className="font-medium">{renderAnswer(answers[question.key]!)}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {notes ? (
          <div className="rounded-lg bg-surface-sunken px-3 py-2 text-sm">
            <p className="text-fg-muted">Your note</p>
            <p className="whitespace-pre-line">{notes}</p>
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
