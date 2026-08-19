/**
 * Periodic housekeeping.
 *
 * Each task is idempotent and bounded, so running it twice is harmless and a
 * large backlog cannot monopolise a worker.
 *
 * Note what is deliberately absent: nothing here auto-marks an appointment as a
 * no-show. Whether a customer turned up is an observation, not something a
 * scheduler can infer from a clock — marking it is an explicit staff action
 * (`POST /appointments/:id/no-show`), guarded by the configured grace period.
 */
import { Op } from 'sequelize';
import { createLogger } from '../../config/logger';
import { Appointment, IdempotencyKey, RefreshToken, WaitlistEntry } from '../../database/models';
import { startAppointment } from '../../modules/appointments/lifecycle.service';

const log = createLogger('maintenance');

const BATCH_LIMIT = 500;

/**
 * Releases expired waitlist holds.
 *
 * A notified customer gets an exclusive claim on an opening for a configured
 * window. When it lapses the entry returns to ACTIVE so the next eligible
 * customer can be offered the same slot.
 */
export async function expireWaitlistHolds(): Promise<number> {
  const expired = await WaitlistEntry.findAll({
    where: {
      status: 'NOTIFIED',
      holdExpiresAt: { [Op.ne]: null, [Op.lte]: new Date() },
    },
    limit: BATCH_LIMIT,
  });

  for (const entry of expired) {
    await entry.update({
      status: 'ACTIVE',
      holdExpiresAt: null,
      heldSlotStartsAt: null,
    });
  }

  if (expired.length > 0) {
    log.info({ count: expired.length }, 'released expired waitlist holds');
  }
  return expired.length;
}

/**
 * Moves started appointments to IN_PROGRESS.
 *
 * Only appointments the customer has actually checked into are advanced —
 * check-in is evidence they are here, whereas the clock alone is not.
 *
 * Each promotion goes through `startAppointment` rather than a bare `update()`
 * here. A status change made by a job is still a status change: it owes the
 * same status-history and audit rows a member of staff pressing the button
 * would leave, and a diary that cannot say who moved an appointment — or that a
 * scheduler did — is a diary nobody can reconstruct afterwards.
 */
export async function advanceInProgress(): Promise<number> {
  const now = new Date();
  const starting = await Appointment.findAll({
    where: {
      status: { [Op.in]: ['CONFIRMED', 'RESCHEDULED'] },
      checkedInAt: { [Op.ne]: null },
      startsAt: { [Op.lte]: now },
      endsAt: { [Op.gt]: now },
    },
    limit: BATCH_LIMIT,
  });

  let advanced = 0;
  for (const appointment of starting) {
    try {
      await startAppointment({
        businessId: appointment.businessId,
        appointmentId: appointment.id,
        actor: { type: 'SYSTEM', label: 'maintenance.advance_in_progress' },
        reason: 'Checked in and the start time has passed.',
      });
      advanced += 1;
    } catch (error) {
      // One appointment that moved between the scan and its transaction —
      // cancelled while the customer sat in the waiting room, completed by
      // hand — must not stop the rest of the batch. `startAppointment` re-reads
      // the row under a lock, so a state that no longer permits the promotion
      // is refused there rather than overwritten here.
      log.warn(
        { err: error, appointmentId: appointment.id },
        'could not advance an appointment to IN_PROGRESS',
      );
    }
  }

  if (advanced > 0) {
    log.info({ count: advanced }, 'advanced checked-in appointments to IN_PROGRESS');
  }
  return advanced;
}

/**
 * Deletes refresh tokens that expired long enough ago to be useless.
 *
 * The 30-day grace keeps recently-revoked rows around so reuse detection can
 * still recognise a stolen token instead of treating it as merely unknown.
 */
export async function purgeExpiredTokens(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const removed = await RefreshToken.destroy({ where: { expiresAt: { [Op.lt]: cutoff } } });
  if (removed > 0) log.info({ removed }, 'purged expired refresh tokens');
  return removed;
}

/** Drops idempotency records past their TTL. */
export async function purgeIdempotencyKeys(): Promise<number> {
  const removed = await IdempotencyKey.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
  if (removed > 0) log.info({ removed }, 'purged expired idempotency keys');
  return removed;
}
