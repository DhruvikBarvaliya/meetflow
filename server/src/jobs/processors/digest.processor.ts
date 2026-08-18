/**
 * The owner's daily digest.
 *
 * A workspace owner should be able to read one message in the morning and know
 * what the day looks like, without opening the dashboard. That is what
 * `OWNER_DAILY_DIGEST` is for — a template that shipped with the product and,
 * until this file existed, was never enqueued by anything.
 *
 * Two things make a digest awkward that a per-booking notification does not
 * have to think about, and both are settled here rather than by the caller:
 *
 *  1. **"Morning" is local.** Each workspace has its own timezone, so there is
 *     no single instant at which every digest is due. The job therefore runs
 *     every hour and asks PostgreSQL which workspaces are currently *in* their
 *     digest hour, rather than trying to schedule one timer per workspace.
 *  2. **It must not send twice.** An hourly job that overlaps its own hour, a
 *     worker that restarts, a repeat that fires twice after a deploy — all of
 *     them would otherwise produce a second digest. The outbox already has the
 *     answer: a dedupe key of workspace plus local date means the second insert
 *     is recognised as a duplicate and dropped, so idempotency is a property of
 *     the row rather than of the scheduler's punctuality.
 *
 * A workspace with nothing in the diary gets no digest. That is expressed as an
 * inner join rather than a filter: "here is your day: 0 appointments" is a
 * message that teaches an owner to ignore the ones that matter.
 */
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../config/database';
import { env } from '../../config/env';
import { createLogger } from '../../config/logger';
import { enqueueNotification } from '../../modules/notifications/notification.service';
import { formatForHumans } from '../../utils/time';

const log = createLogger('digest');

/**
 * The local hour a digest is sent in.
 *
 * 07:00 in the workspace's own zone: before the first appointment of a normal
 * working day, late enough not to arrive overnight. Fixed rather than
 * configurable because `business_settings` has no column for it, and a
 * migration is not something this job should be inventing.
 */
const DIGEST_LOCAL_HOUR = 7;

interface DigestRow {
  business_id: string;
  business_name: string;
  timezone: string;
  owner_user_id: string;
  owner_email: string;
  local_date: string;
  appointment_count: number;
  first_starts_at: Date;
  last_starts_at: Date;
}

/**
 * Workspaces whose local clock is inside the digest hour right now, with the
 * figures for their own calendar day.
 *
 * The day is cut by PostgreSQL in each workspace's zone — the same rule the
 * analytics module follows, and for the same reason: computing it in JavaScript
 * would silently use the worker's zone, which is UTC in production and the
 * developer's in testing.
 *
 * `local_date` leaves the database as text. A `date` column is materialised by
 * node-postgres at the *server's* local midnight, which is the previous day for
 * anyone west of Greenwich — and this value goes into a dedupe key, where being
 * a day out means sending two digests for one day.
 */
const DUE_DIGESTS_SQL = `
  WITH due AS (
    SELECT b.id, b.name, b.timezone, b.owner_user_id,
           (now() AT TIME ZONE b.timezone)::date AS local_date
    FROM businesses b
    WHERE b.deleted_at IS NULL
      AND b.status = 'ACTIVE'
      AND EXTRACT(HOUR FROM now() AT TIME ZONE b.timezone)::int = $hour
  )
  SELECT
    d.id                                    AS business_id,
    d.name                                  AS business_name,
    d.timezone,
    u.id                                    AS owner_user_id,
    u.email                                 AS owner_email,
    to_char(d.local_date, 'YYYY-MM-DD')     AS local_date,
    COUNT(a.id)::int                        AS appointment_count,
    MIN(a.starts_at)                        AS first_starts_at,
    MAX(a.starts_at)                        AS last_starts_at
  FROM due d
  JOIN users u
    ON u.id = d.owner_user_id
   AND u.deleted_at IS NULL
   AND u.status = 'ACTIVE'
  JOIN appointments a
    ON a.business_id = d.id
   AND a.starts_at >= (d.local_date::timestamp AT TIME ZONE d.timezone)
   AND a.starts_at <  ((d.local_date + 1)::timestamp AT TIME ZONE d.timezone)
   -- A cancelled or rejected booking is not part of anybody's day.
   AND a.status NOT IN ('CANCELLED', 'REJECTED')
  GROUP BY d.id, d.name, d.timezone, u.id, u.email, d.local_date`;

/**
 * Queues one digest per workspace that is currently in its digest hour.
 *
 * Returns how many rows were written, which is what the caller logs — a count
 * of zero is normal and means no workspace's morning is happening right now.
 */
export async function sendOwnerDailyDigests(): Promise<number> {
  const rows = await sequelize.query<DigestRow>(DUE_DIGESTS_SQL, {
    type: QueryTypes.SELECT,
    bind: { hour: DIGEST_LOCAL_HOUR },
  });

  let queued = 0;
  for (const row of rows) {
    const written = await enqueueNotification({
      businessId: row.business_id,
      type: 'OWNER_DAILY_DIGEST',
      recipientType: 'OWNER',
      recipientUserId: row.owner_user_id,
      recipientAddress: row.owner_email,
      payload: {
        businessName: row.business_name,
        appointmentCount: row.appointment_count,
        firstAppointmentLocal: formatForHumans(row.first_starts_at, row.timezone),
        lastAppointmentLocal: formatForHumans(row.last_starts_at, row.timezone),
        dashboardUrl: `${env.PUBLIC_APP_URL}/app/dashboard`,
      },
      // One digest per workspace per local day, whatever the scheduler does.
      dedupeKey: `digest:${row.business_id}:${row.local_date}`,
    });
    if (written) queued += 1;
  }

  if (queued > 0) log.info({ queued }, 'queued owner daily digests');
  return queued;
}
