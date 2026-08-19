import { useQuery } from '@tanstack/react-query';
import { ShieldX, Sparkles, TriangleAlert } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { DataState, ownerKeys, type StaffServiceLink } from '@/components/owner';
import {
  Badge,
  Card,
  CardBody,
  EmptyState,
  ErrorState,
  Skeleton,
  TBody,
  THead,
  Table,
  TableContainer,
  Td,
  Th,
  Tr,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api } from '@/lib/apiClient';
import { formatDuration, formatMoney } from '@/lib/format';
import { PERMISSIONS } from '@/lib/permissions';
import { useMyStaffProfile } from './useMyStaffProfile';

/**
 * What this provider is expected to deliver.
 *
 * A STAFF member holds `services:read`, so the catalogue page already shows
 * them every service the workspace sells — and gives them no way at all to tell
 * which of those they are actually assigned to. That is the gap this page
 * fills, and it is a real one: which services someone is on decides which
 * bookings can land in their diary, so it is not information they can be
 * expected to hold in their head or ask about.
 *
 * It is read-only, and deliberately so. Assignment is a rota decision, not a
 * personal preference: it governs who a customer can be offered, so it belongs
 * to whoever is responsible for the rota. `PUT /staff/:id/services` requires
 * `staff:manage`, which the STAFF role does not hold, and a page that offered
 * controls the API would refuse would be worse than one that offers none. The
 * page therefore says plainly where the change is actually made instead of
 * pretending it can be made here.
 *
 * The reason it can show anything at all is `staff:read`, which every seeded
 * role holds — the same permission `useMyStaffProfile` already leans on to work
 * out whose profile this is.
 */

const CHANGED_BY =
  'Assignment is changed by an owner or manager, on the Staff page under your profile. Ask them if something here looks wrong.';

/** A number the assignment overrides for this provider only. */
function OverrideNote({ children }: { children: string }): JSX.Element {
  return <span className="block text-xs text-fg-muted">{children}</span>;
}

export default function MyServicesPage(): JSX.Element {
  const { activeBusinessId, can } = useAuth();
  const { staffProfileId, profile, isLoading, isError, refetch } = useMyStaffProfile();

  const description =
    'The services you are assigned to. Anything not listed here is never offered with your name on it.';

  const linksQuery = useQuery({
    queryKey: ownerKeys.staffServices(activeBusinessId, staffProfileId ?? ''),
    queryFn: () => api.get<StaffServiceLink[]>(`/staff/${staffProfileId ?? ''}/services`),
    enabled: staffProfileId !== null,
  });

  /*
   * The roster lookup is gated on `staff:read`, so a custom role without it
   * would resolve no profile and land in the "you have no provider profile"
   * branch below — which would be a plainly false statement about their
   * account. The refusal is named for what it is instead.
   */
  if (!can(PERMISSIONS.STAFF_READ) && staffProfileId === null) {
    return (
      <>
        <PageHeader title="My services" description={description} />
        <Card>
          <EmptyState
            icon={<ShieldX className="size-6" aria-hidden="true" />}
            title="Reading the provider roster is not part of your role"
            description="This page works out which services are yours by reading your provider profile, and your role in this workspace cannot read it. An owner or manager can change that."
          />
        </Card>
      </>
    );
  }

  if (isLoading) {
    return (
      <>
        <PageHeader title="My services" description={description} />
        <Card>
          <CardBody className="flex flex-col gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </CardBody>
        </Card>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <PageHeader title="My services" description={description} />
        <Card>
          {/* The roster lookup reports failure without surfacing the error
              object, so the generic presentation is the honest one here. */}
          <ErrorState
            error={null}
            onRetry={refetch}
            title="We could not work out whose services to show"
          />
        </Card>
      </>
    );
  }

  if (staffProfileId === null) {
    return (
      <>
        <PageHeader title="My services" description={description} />
        <Card>
          <EmptyState
            icon={<TriangleAlert className="size-6" aria-hidden="true" />}
            title="You have no provider profile here"
            description="Services are assigned to a provider profile, and your account does not have one in this workspace. An owner or manager can create it."
          />
        </Card>
      </>
    );
  }

  const links = linksQuery.data ?? [];

  return (
    <>
      <PageHeader
        title="My services"
        description={description}
        actions={
          profile ? (
            <Badge tone={profile.isBookable ? 'success' : 'warning'} dot>
              {profile.isBookable ? 'Bookable' : 'Not bookable'}
            </Badge>
          ) : null
        }
      />

      {profile && !profile.isBookable ? (
        <div
          role="status"
          className="flex items-start gap-2.5 rounded-md border border-warning-border bg-warning-subtle px-3.5 py-3 text-sm text-warning-text"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p className="leading-relaxed">
            Your profile is marked as not bookable, so none of the services below are being offered
            with your name on them at the moment, whatever their own status says.
          </p>
        </div>
      ) : null}

      <Card>
        <DataState
          isPending={linksQuery.isPending}
          isError={linksQuery.isError}
          error={linksQuery.error}
          onRetry={() => void linksQuery.refetch()}
          isEmpty={links.length === 0}
          columns={4}
          empty={
            <EmptyState
              icon={<Sparkles className="size-6" aria-hidden="true" />}
              title="No services are assigned to you"
              description={`Nothing can be booked with you until at least one service is. ${CHANGED_BY}`}
            />
          }
        >
          <TableContainer>
            <Table caption="Services you are assigned to deliver">
              <THead>
                <Tr>
                  <Th>Service</Th>
                  <Th align="right">Duration</Th>
                  <Th align="right">Price</Th>
                  <Th>Offered</Th>
                </Tr>
              </THead>
              <TBody>
                {links.map((link) => {
                  /*
                   * Two separate switches, and running them together would hide
                   * a real distinction: the catalogue can retire a service for
                   * everybody, and an assignment can be suspended for one
                   * person while the service carries on. Someone asking "why am
                   * I not getting these bookings any more" needs to know which
                   * of the two happened.
                   */
                  const serviceRetired = !link.service.isActive;
                  const assignmentPaused = !link.isActive;
                  const duration = link.durationMinutesOverride ?? link.service.durationMinutes;
                  const price = link.priceAmountOverride ?? link.service.priceAmount;

                  return (
                    <Tr key={link.id}>
                      <Td>
                        <span className="font-medium text-fg">{link.service.name}</span>
                      </Td>
                      <Td numeric>
                        {formatDuration(duration)}
                        {link.durationMinutesOverride !== null ? (
                          <OverrideNote>
                            {`Set for you; normally ${formatDuration(link.service.durationMinutes)}`}
                          </OverrideNote>
                        ) : null}
                      </Td>
                      <Td numeric>
                        {formatMoney(price, link.service.currency)}
                        {link.priceAmountOverride !== null ? (
                          <OverrideNote>
                            {`Set for you; normally ${formatMoney(
                              link.service.priceAmount,
                              link.service.currency,
                            )}`}
                          </OverrideNote>
                        ) : null}
                      </Td>
                      <Td>
                        {serviceRetired ? (
                          <Badge tone="neutral">Service retired</Badge>
                        ) : assignmentPaused ? (
                          <Badge tone="warning">Paused for you</Badge>
                        ) : (
                          <Badge tone="success">Yes</Badge>
                        )}
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
          </TableContainer>

          <CardBody className="border-t border-border">
            <p className="text-sm leading-relaxed text-fg-muted">
              {CHANGED_BY} Durations and prices marked as set for you override the catalogue for
              your bookings only.
            </p>
          </CardBody>
        </DataState>
      </Card>
    </>
  );
}
