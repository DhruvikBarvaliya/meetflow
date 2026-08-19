/**
 * The two visibility helpers, which decide what a page even tries to ask for.
 *
 * Getting these wrong is not a rendering bug. The server refuses what it should
 * refuse either way, so a widened client answer produces a page that requests
 * the whole diary and shows a member of staff a 403 where their own bookings
 * should be; a narrowed one hides rows an owner is entitled to and looks like
 * data loss. Neither shows up as an error anywhere.
 *
 * The permission strings asserted here are the wire contract with
 * `server/src/modules/auth/permissions.ts`. They are written out in full rather
 * than referenced through `PERMISSIONS`, so that renaming the constant on one
 * side and not the other fails here instead of silently degrading every role to
 * `NONE`.
 */
import { describe, expect, it } from 'vitest';
import { appointmentVisibility, customerVisibility, isSystemRoleKey } from './permissions';

describe('appointmentVisibility', () => {
  it('gives the whole diary only to the broad permission', () => {
    expect(appointmentVisibility(new Set(['appointments:read']))).toBe('ALL');
  });

  it('gives a provider their own rows', () => {
    expect(appointmentVisibility(new Set(['appointments:read:own']))).toBe('OWN');
  });

  it('prefers the broad permission when a member holds both', () => {
    // A manager template can carry both. Answering OWN would hide colleagues'
    // bookings from someone the workspace granted the whole diary to.
    expect(appointmentVisibility(new Set(['appointments:read', 'appointments:read:own']))).toBe(
      'ALL',
    );
  });

  it('answers NONE for a member holding neither', () => {
    // Deliberately including a near-miss: holding `appointments:create` is not
    // permission to read, and a prefix match would say otherwise.
    expect(appointmentVisibility(new Set(['appointments:create', 'services:read']))).toBe('NONE');
    expect(appointmentVisibility(new Set())).toBe('NONE');
  });
});

describe('customerVisibility', () => {
  it('separates the whole address book from the people you have served', () => {
    expect(customerVisibility(new Set(['customers:read']))).toBe('ALL');
    expect(customerVisibility(new Set(['customers:read:assigned']))).toBe('ASSIGNED');
  });

  it('prefers the broad permission when a member holds both', () => {
    expect(customerVisibility(new Set(['customers:read', 'customers:read:assigned']))).toBe('ALL');
  });

  it('answers NONE for a member holding neither', () => {
    expect(customerVisibility(new Set(['customers:create']))).toBe('NONE');
    expect(customerVisibility(new Set())).toBe('NONE');
  });
});

describe('isSystemRoleKey', () => {
  it('recognises the four seeded templates', () => {
    expect(isSystemRoleKey('BUSINESS_OWNER')).toBe(true);
    expect(isSystemRoleKey('MANAGER')).toBe(true);
    expect(isSystemRoleKey('STAFF')).toBe(true);
    expect(isSystemRoleKey('RECEPTIONIST')).toBe(true);
  });

  it('treats anything else as a custom role', () => {
    // The distinction gates whether the UI offers to edit a role's permissions,
    // so a custom role misread as seeded becomes uneditable.
    expect(isSystemRoleKey('CLINIC_LEAD')).toBe(false);
    expect(isSystemRoleKey('OWNER')).toBe(false);
    expect(isSystemRoleKey('business_owner')).toBe(false);
    expect(isSystemRoleKey('')).toBe(false);
  });
});
