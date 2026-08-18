import { Badge, type BadgeTone } from '@/components/ui';
import { humanizeEnum } from '@/lib/format';
import type { AppointmentStatus, MembershipStatus, WaitlistStatus } from '@/types/api';

/**
 * Status pills.
 *
 * Tone is assigned by what the status means to the business, not by where it
 * sits in an enum: `NO_SHOW` and `CANCELLED` both end a booking but only one of
 * them cost the workspace the slot, so they do not share a colour.
 *
 * Every pill carries its own text. Colour is never the only signal, which is
 * what keeps these readable for a colour-blind operator and in a printout.
 */

const APPOINTMENT_TONES: Record<AppointmentStatus, BadgeTone> = {
  PENDING: 'warning',
  CONFIRMED: 'success',
  IN_PROGRESS: 'info',
  COMPLETED: 'brand',
  CANCELLED: 'neutral',
  NO_SHOW: 'danger',
  REJECTED: 'danger',
  RESCHEDULED: 'info',
};

/** The wording operators use, where it differs from the raw enum. */
const APPOINTMENT_LABELS: Partial<Record<AppointmentStatus, string>> = {
  IN_PROGRESS: 'In progress',
  NO_SHOW: 'No-show',
};

export function AppointmentStatusBadge({
  status,
  className,
}: {
  status: AppointmentStatus;
  className?: string;
}): JSX.Element {
  return (
    <Badge tone={APPOINTMENT_TONES[status]} dot className={className}>
      {APPOINTMENT_LABELS[status] ?? humanizeEnum(status)}
    </Badge>
  );
}

const WAITLIST_TONES: Record<WaitlistStatus, BadgeTone> = {
  ACTIVE: 'info',
  HELD: 'warning',
  CONVERTED: 'success',
  CANCELLED: 'neutral',
  EXPIRED: 'neutral',
};

export function WaitlistStatusBadge({ status }: { status: WaitlistStatus }): JSX.Element {
  return (
    <Badge tone={WAITLIST_TONES[status]} dot>
      {humanizeEnum(status)}
    </Badge>
  );
}

type CustomerStatus = 'ACTIVE' | 'BLOCKED' | 'ARCHIVED';

const CUSTOMER_TONES: Record<CustomerStatus, BadgeTone> = {
  ACTIVE: 'success',
  BLOCKED: 'danger',
  ARCHIVED: 'neutral',
};

export function CustomerStatusBadge({ status }: { status: CustomerStatus }): JSX.Element {
  return (
    <Badge tone={CUSTOMER_TONES[status]} dot>
      {humanizeEnum(status)}
    </Badge>
  );
}

const MEMBERSHIP_TONES: Record<MembershipStatus, BadgeTone> = {
  INVITED: 'warning',
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  REMOVED: 'neutral',
};

export function MembershipStatusBadge({ status }: { status: MembershipStatus }): JSX.Element {
  return (
    <Badge tone={MEMBERSHIP_TONES[status]} dot>
      {humanizeEnum(status)}
    </Badge>
  );
}

/**
 * Active / inactive, for the many configuration rows that carry only a flag.
 *
 * "Inactive" rather than a greyed-out row: a row nobody can see is a row nobody
 * can turn back on.
 */
export function ActiveBadge({ active }: { active: boolean }): JSX.Element {
  return (
    <Badge tone={active ? 'success' : 'neutral'} dot>
      {active ? 'Active' : 'Inactive'}
    </Badge>
  );
}
