import { expect, test } from '@playwright/test';
import { apiCall, createBookableWorkspace, type OwnerFixture } from '../fixtures/api';

/**
 * Tenant isolation, end to end.
 *
 * A successful cross-tenant read is a release blocker, so these assertions are
 * made against the running stack rather than only in the integration suite.
 */
let alpha: OwnerFixture;
let beta: OwnerFixture;

test.beforeAll(async () => {
  alpha = await createBookableWorkspace('alpha');
  beta = await createBookableWorkspace('beta');
});

test.describe('cross-tenant isolation', () => {
  test("one workspace cannot read another's data by naming its id", async () => {
    await expect(
      apiCall('/api/v1/workspace', { token: beta.token, businessId: alpha.businessId }),
    ).rejects.toThrow(/404/);
  });

  test("one workspace cannot fetch another's resource by id", async () => {
    // 404, not 403 — a 403 would confirm the record exists.
    await expect(
      apiCall(`/api/v1/locations/${alpha.locationId}`, {
        token: beta.token,
        businessId: beta.businessId,
      }),
    ).rejects.toThrow(/404/);
  });

  test('each workspace sees only its own catalogue', async () => {
    const alphaServices = await apiCall<Array<{ id: string; name: string }>>(
      '/api/v1/services?pageSize=50',
      { token: alpha.token, businessId: alpha.businessId },
    );
    const betaServices = await apiCall<Array<{ id: string; name: string }>>(
      '/api/v1/services?pageSize=50',
      { token: beta.token, businessId: beta.businessId },
    );

    expect(alphaServices.some((service) => service.id === alpha.serviceId)).toBe(true);
    expect(alphaServices.some((service) => service.id === beta.serviceId)).toBe(false);
    expect(betaServices.some((service) => service.id === alpha.serviceId)).toBe(false);
  });

  test('a booking cannot be made against another tenant’s service', async () => {
    await expect(
      apiCall(`/api/v1/public/booking-links/${alpha.bookingSlug}/bookings`, {
        method: 'POST',
        body: {
          // Alpha's link, Beta's service.
          serviceId: beta.serviceId,
          staffProfileId: beta.staffProfileId,
          startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          timezone: 'Asia/Kolkata',
          customer: { firstName: 'Cross', lastName: 'Tenant', email: 'cross@meetflow.test' },
        },
      }),
    ).rejects.toThrow(/404|409|422/);
  });

  test('management endpoints reject an unauthenticated caller', async () => {
    await expect(apiCall('/api/v1/appointments')).rejects.toThrow(/401/);
    await expect(apiCall('/api/v1/analytics/overview')).rejects.toThrow(/401/);
  });
});
