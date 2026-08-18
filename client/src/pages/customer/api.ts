import type { AppointmentStatus, Customer, Service } from '@/types/api';

/**
 * Shapes the customer surface reads that the shared contract types do not cover,
 * each taken from a live response of the running API.
 */

/**
 * How a customer wants to be contacted.
 *
 * `reminderOffsetsMinutes` is absent until the customer overrides the
 * workspace's own schedule, which is why it is optional rather than defaulted:
 * "they have not chosen" and "they chose none" are different facts, and the
 * pages say which one is in force.
 */
export interface CustomerCommunicationPreferences {
  emailEnabled: boolean;
  smsEnabled: boolean;
  marketingOptIn: boolean;
  reminderOffsetsMinutes?: number[];
}

export interface CustomerRecord extends Omit<Customer, 'communicationPreferences'> {
  communicationPreferences: CustomerCommunicationPreferences;
}

/** A row from `GET /customers/:id/appointments` — narrower than the diary's. */
export interface CustomerAppointmentSummary {
  id: string;
  publicId: string;
  status: AppointmentStatus;
  startsAt: string;
  endsAt: string;
  durationMinutes: number;
  timezone: string;
  priceAmount: number;
  currency: string;
  source: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  service: Pick<Service, 'id' | 'name' | 'slug' | 'durationMinutes'> | null;
  staffProfile: { id: string; displayName: string } | null;
  location: { id: string; name: string; timezone: string } | null;
}

export const customerKeys = {
  record: (businessId: string | null, email: string) =>
    ['customer', 'record', businessId, email] as const,
  appointments: (businessId: string | null, customerId: string, scope: string, page: number) =>
    ['customer', 'appointments', businessId, customerId, scope, page] as const,
  booking: (publicId: string) => ['customer', 'booking', publicId] as const,
} as const;

/** Builds a query string, dropping anything the caller left undefined. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}
