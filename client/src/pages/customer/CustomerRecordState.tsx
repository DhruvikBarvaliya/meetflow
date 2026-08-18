import { ShieldQuestion, UserSearch } from 'lucide-react';
import { Card, CardBody, EmptyState, ErrorState, Skeleton } from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import type { MyCustomerState } from './useMyCustomer';

/**
 * What the customer pages show when there is no record to show.
 *
 * Each branch is a different fact and says so plainly rather than collapsing
 * into one "nothing here": a role that cannot read the address book, an address
 * with no bookings in this workspace, and a failed request all need different
 * things from the reader.
 */
export function CustomerRecordState({
  state,
  onRetry,
}: {
  state: Exclude<MyCustomerState, { status: 'ready' }>;
  onRetry: () => void;
}): JSX.Element {
  const { user, activeMembership } = useAuth();
  const workspaceName = activeMembership?.businessName ?? 'this workspace';

  if (state.status === 'loading') {
    return (
      <Card>
        <CardBody className="flex flex-col gap-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardBody>
      </Card>
    );
  }

  if (state.status === 'error') {
    return (
      <Card>
        <ErrorState error={state.error} onRetry={onRetry} />
      </Card>
    );
  }

  if (state.status === 'forbidden') {
    return (
      <Card>
        <EmptyState
          icon={<ShieldQuestion className="size-6" aria-hidden="true" />}
          title="Your role cannot look this up"
          description={`Finding your own customer record in ${workspaceName} needs permission to read its customers, which your role does not include. If you have a booking confirmation, the link in it opens the booking directly.`}
        />
      </Card>
    );
  }

  return (
    <Card>
      <EmptyState
        icon={<UserSearch className="size-6" aria-hidden="true" />}
        title="No bookings under your email here"
        description={`${workspaceName} has no customer record for ${user?.email ?? 'your address'}. Anything you book with that address will appear here.`}
      />
    </Card>
  );
}
