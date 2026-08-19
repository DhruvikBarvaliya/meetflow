/**
 * Audit trail.
 *
 * Every security-relevant and business-relevant mutation writes one row here.
 * Records are append-only: nothing in the application updates or deletes them.
 *
 * Failure policy is deliberate:
 *  - inside a transaction, a failed audit insert *does* fail the operation —
 *    the audit record and the change it describes are one atomic unit;
 *  - outside a transaction, a failure is logged and swallowed, because losing
 *    an audit line must not turn a successful booking into a 500 for the user.
 */
import type { Transaction } from 'sequelize';
import { createLogger } from '../../config/logger';
import { AuditLog } from '../../database/models';

const log = createLogger('audit');

export const AuditActions = {
  // Authentication / security
  USER_REGISTERED: 'user.registered',
  USER_LOGIN_SUCCEEDED: 'user.login_succeeded',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGIN_BLOCKED: 'user.login_blocked',
  USER_LOGGED_OUT: 'user.logged_out',
  USER_LOGGED_OUT_ALL: 'user.logged_out_all',
  USER_TOKEN_REFRESHED: 'user.token_refreshed',
  USER_TOKEN_REUSE_DETECTED: 'user.token_reuse_detected',
  USER_PASSWORD_CHANGED: 'user.password_changed',
  USER_PASSWORD_RESET_REQUESTED: 'user.password_reset_requested',
  USER_PASSWORD_RESET_COMPLETED: 'user.password_reset_completed',
  USER_EMAIL_VERIFIED: 'user.email_verified',

  // Workspace
  BUSINESS_CREATED: 'business.created',
  BUSINESS_UPDATED: 'business.updated',
  BUSINESS_SETTINGS_UPDATED: 'business.settings_updated',
  MEMBERSHIP_INVITED: 'membership.invited',
  MEMBERSHIP_UPDATED: 'membership.updated',
  MEMBERSHIP_REMOVED: 'membership.removed',
  ROLE_CREATED: 'role.created',
  ROLE_UPDATED: 'role.updated',
  ROLE_PERMISSIONS_CHANGED: 'role.permissions_changed',

  // Structure & catalogue
  LOCATION_CREATED: 'location.created',
  LOCATION_UPDATED: 'location.updated',
  LOCATION_DELETED: 'location.deleted',
  TEAM_CREATED: 'team.created',
  TEAM_UPDATED: 'team.updated',
  STAFF_CREATED: 'staff.created',
  STAFF_UPDATED: 'staff.updated',
  STAFF_DELETED: 'staff.deleted',
  SERVICE_CREATED: 'service.created',
  SERVICE_UPDATED: 'service.updated',
  SERVICE_DELETED: 'service.deleted',
  RESOURCE_CREATED: 'resource.created',
  RESOURCE_UPDATED: 'resource.updated',
  RESOURCE_DELETED: 'resource.deleted',

  // Availability
  AVAILABILITY_UPDATED: 'availability.updated',
  AVAILABILITY_OVERRIDE_CREATED: 'availability.override_created',
  AVAILABILITY_OVERRIDE_DELETED: 'availability.override_deleted',
  HOLIDAY_CREATED: 'holiday.created',
  HOLIDAY_DELETED: 'holiday.deleted',
  BLACKOUT_CREATED: 'blackout.created',
  BLACKOUT_DELETED: 'blackout.deleted',

  // Booking lifecycle
  BOOKING_LINK_CREATED: 'booking_link.created',
  BOOKING_LINK_UPDATED: 'booking_link.updated',
  APPOINTMENT_CREATED: 'appointment.created',
  APPOINTMENT_CONFIRMED: 'appointment.confirmed',
  APPOINTMENT_APPROVED: 'appointment.approved',
  APPOINTMENT_REJECTED: 'appointment.rejected',
  APPOINTMENT_RESCHEDULED: 'appointment.rescheduled',
  APPOINTMENT_CANCELLED: 'appointment.cancelled',
  // Arrival and start are their own verbs rather than APPOINTMENT_UPDATED,
  // which covers edits to an appointment's fields. Both answer questions a
  // business gets asked and an edit log cannot: "they never turned up" against
  // "they were here at 10:05", and when the visit actually began.
  APPOINTMENT_CHECKED_IN: 'appointment.checked_in',
  APPOINTMENT_STARTED: 'appointment.started',
  APPOINTMENT_COMPLETED: 'appointment.completed',
  APPOINTMENT_NO_SHOW: 'appointment.no_show',
  APPOINTMENT_UPDATED: 'appointment.updated',

  // Customers & waitlist
  CUSTOMER_CREATED: 'customer.created',
  CUSTOMER_UPDATED: 'customer.updated',
  CUSTOMER_DELETED: 'customer.deleted',
  WAITLIST_CREATED: 'waitlist.created',
  WAITLIST_NOTIFIED: 'waitlist.notified',
  WAITLIST_CONVERTED: 'waitlist.converted',
  WAITLIST_CANCELLED: 'waitlist.cancelled',

  // Communication & integration
  NOTIFICATION_TEMPLATE_UPDATED: 'notification_template.updated',
  AUTOMATION_RULE_CREATED: 'automation_rule.created',
  AUTOMATION_RULE_UPDATED: 'automation_rule.updated',
  WEBHOOK_ENDPOINT_CREATED: 'webhook_endpoint.created',
  WEBHOOK_ENDPOINT_UPDATED: 'webhook_endpoint.updated',
  WEBHOOK_ENDPOINT_DELETED: 'webhook_endpoint.deleted',

  // Reporting
  REPORT_EXPORTED: 'report.exported',

  // Platform administration
  PLATFORM_WORKSPACE_STATUS_CHANGED: 'platform.workspace_status_changed',
  PLATFORM_USER_STATUS_CHANGED: 'platform.user_status_changed',
  PLATFORM_USER_ROLE_CHANGED: 'platform.user_role_changed',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

export interface AuditInput {
  businessId?: string | null;
  actorType: 'USER' | 'CUSTOMER' | 'SYSTEM' | 'PUBLIC' | 'API';
  actorUserId?: string | null;
  actorCustomerId?: string | null;
  actorLabel?: string | null;
  action: AuditAction | string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Keys that must never reach an audit row. Audit logs are read by support and
 * exported by owners, so they are treated as a low-trust destination.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'currentpassword',
  'newpassword',
  'token',
  'accesstoken',
  'refreshtoken',
  'access_token',
  'refresh_token',
  'tokenhash',
  'secret',
  'signingsecret',
  'signing_secret',
  'authorization',
  'cookie',
]);

const MAX_METADATA_STRING = 500;

/** Recursively strips secrets and bounds the size of audit metadata. */
function sanitiseMetadata(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') {
    return value.length > MAX_METADATA_STRING ? `${value.slice(0, MAX_METADATA_STRING)}…` : value;
  }
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitiseMetadata(item, depth + 1));
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
        out[key] = '[redacted]';
        continue;
      }
      out[key] = sanitiseMetadata(item, depth + 1);
    }
    return out;
  }
  return value;
}

export async function recordAudit(
  input: AuditInput,
  options: { transaction?: Transaction } = {},
): Promise<void> {
  const row = {
    businessId: input.businessId ?? null,
    actorType: input.actorType,
    actorUserId: input.actorUserId ?? null,
    actorCustomerId: input.actorCustomerId ?? null,
    actorLabel: input.actorLabel ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    requestId: input.requestId ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ? input.userAgent.slice(0, 500) : null,
    metadata: (sanitiseMetadata(input.metadata ?? {}) ?? {}) as Record<string, unknown>,
  };

  if (options.transaction) {
    // Part of the atomic unit: if this fails, the change it describes must not
    // be committed either.
    await AuditLog.create(row, { transaction: options.transaction });
    return;
  }

  try {
    await AuditLog.create(row);
  } catch (error) {
    log.error(
      { err: error, action: input.action, entityType: input.entityType },
      'audit write failed',
    );
  }
}
