import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import { PERMISSIONS } from '@/lib/permissions';
import { customerKeys, queryString, type CustomerRecord } from './api';

/**
 * Why the address book is searched instead of read directly.
 *
 * `customers.user_id` links a customer record to a login, but the API never
 * exposes it as a filter — `customers.validation.ts` says linking the two is an
 * identity decision, not an address-book edit — and there is no "my customer
 * record" endpoint. `GET /customers?search=` matches first name, last name and
 * email, so the signed-in address is searched and the result accepted **only on
 * an exact email match**: a partial name collision must never hand one person
 * another person's bookings.
 */
export type MyCustomerState =
  | { status: 'loading' }
  /** The role cannot read the address book, so the record cannot be found. */
  | { status: 'forbidden' }
  /** Resolved, and this workspace holds no customer record for this address. */
  | { status: 'missing' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; customer: CustomerRecord };

export interface MyCustomerResult {
  state: MyCustomerState;
  /** Convenience accessor: the record, or null in every other state. */
  customer: CustomerRecord | null;
  refetch: () => void;
}

export function useMyCustomer(): MyCustomerResult {
  const { activeBusinessId, user, can } = useAuth();
  const email = user?.email ?? '';
  const mayRead = can(PERMISSIONS.CUSTOMERS_READ);

  const query = useQuery({
    queryKey: customerKeys.record(activeBusinessId, email),
    queryFn: () =>
      api.getPage<CustomerRecord>(`/customers${queryString({ search: email, pageSize: 5 })}`),
    // Asking without the permission buys a guaranteed 403 and a retry storm.
    enabled: mayRead && email.length > 0 && activeBusinessId !== null,
    staleTime: 60_000,
  });

  const refetch = (): void => {
    void query.refetch();
  };

  if (!mayRead) return { state: { status: 'forbidden' }, customer: null, refetch };
  if (query.isPending) return { state: { status: 'loading' }, customer: null, refetch };
  if (query.isError)
    return { state: { status: 'error', error: query.error }, customer: null, refetch };

  const match =
    query.data.items.find((entry) => entry.email?.toLowerCase() === email.toLowerCase()) ?? null;

  if (match === null) return { state: { status: 'missing' }, customer: null, refetch };
  return { state: { status: 'ready', customer: match }, customer: match, refetch };
}
