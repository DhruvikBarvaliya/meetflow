/**
 * The account behind the bookings: who you are, who knows you, and the security
 * of both.
 *
 * Deliberately shell-agnostic. It renders only a page body, reads its data from
 * `/me/profile` and `useAuth()`, and reaches neither for a workspace header nor
 * for a permission — so the same component is correct inside `PortalShell` for
 * somebody who holds no membership anywhere, and inside `AppShell` for a member
 * who wants to change their password. Splitting it in two would give the product
 * two "change your password" screens that had to be kept in step.
 *
 * The two lists on it are genuinely different things and are not merged:
 * `workspaces` from `/me/profile` are the businesses that hold a customer record
 * for this person, and `memberships` from `useAuth()` are the workspaces this
 * account can sign in to and work in. One person can appear in both — a
 * therapist who is also somebody else's client — and collapsing them would say
 * they had access to a business whose waiting room they have merely sat in.
 */
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import {
  Building2,
  Eye,
  EyeOff,
  KeyRound,
  LogOut,
  MailCheck,
  MailWarning,
  ShieldCheck,
  Store,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  Skeleton,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';
import { customerName, formatDate, humanizeEnum } from '@/lib/format';
import { SYSTEM_ROLE_LABELS, isSystemRoleKey } from '@/lib/permissions';
import { FormBanner } from '@/pages/auth/FormBanner';
import { PasswordChecklist } from '@/pages/auth/PasswordChecklist';
import { passwordSchema } from '@/pages/auth/passwordSchema';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import { usePortalProfile } from './portalApi';

const changePasswordSchema = z
  .object({
    // Deliberately not the full policy: an existing password may pre-date a rule
    // change, and refusing to submit it would be a dead end.
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Type the new password again.'),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two passwords do not match.',
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    path: ['newPassword'],
    message: 'Choose a password you have not used here before.',
  });

type ChangePasswordValues = z.infer<typeof changePasswordSchema>;

const PASSWORD_FIELDS = ['currentPassword', 'newPassword', 'confirmPassword'] as const;

interface LogoutAllResponse {
  sessionsRevoked: number;
}

function roleLabel(roleKey: string, fallback: string): string {
  return isSystemRoleKey(roleKey) ? SYSTEM_ROLE_LABELS[roleKey] : fallback;
}

function DetailRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{label}</dt>
      <dd className="text-sm text-fg">{value}</dd>
    </div>
  );
}

export default function ProfilePage(): JSX.Element {
  const { memberships, activeBusinessId, logout } = useAuth();
  const profileQuery = usePortalProfile();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [signOutAllOpen, setSignOutAllOpen] = useState(false);

  const form = useForm<ChangePasswordValues>({
    resolver: zodResolver(changePasswordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });
  const { formError, clearFormError, handleApiError } = useFormApiError<ChangePasswordValues>(
    form.setError,
    PASSWORD_FIELDS,
  );

  const newPassword = form.watch('newPassword');
  const account = profileQuery.data?.user ?? null;

  /**
   * Changing a password revokes every refresh token on the account — the server
   * says so and does it — so the only honest thing afterwards is to end this
   * session too and send the person back to sign in.
   */
  const onChangePassword = form.handleSubmit(async (values) => {
    clearFormError();
    try {
      await api.post('/auth/change-password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      toast({
        title: 'Password changed',
        description: 'Every device has been signed out. Sign in again with your new password.',
        tone: 'success',
      });
      await logout();
      navigate('/login', { replace: true });
    } catch (error) {
      handleApiError(error);
    }
  });

  const signOutEverywhere = useMutation({
    mutationFn: () => api.post<LogoutAllResponse>('/auth/logout-all', {}),
    onSuccess: async (result) => {
      setSignOutAllOpen(false);
      toast({
        title:
          result.sessionsRevoked === 1
            ? '1 session signed out'
            : `${result.sessionsRevoked} sessions signed out`,
        description: 'Every device, including this one, has been signed out.',
        tone: 'success',
      });
      await logout();
      navigate('/login', { replace: true });
    },
    onError: (error: unknown) => {
      setSignOutAllOpen(false);
      toast({
        title: 'Could not sign out everywhere',
        description: isApiError(error) ? error.message : 'Please try again in a moment.',
        tone: 'error',
      });
    },
  });

  return (
    <>
      <PageHeader
        title="Your account"
        description="Your details, the businesses that hold a record of you, and the security of both."
      />

      {/* --- Account --------------------------------------------------------- */}
      <Card>
        <CardHeader as="h2" title="Details" description="What MeetFlow holds against your login." />
        <CardBody className="flex flex-col gap-4">
          {profileQuery.isPending ? (
            // A skeleton rather than a row of dashes: an em dash beside "Email"
            // reads as "we have no email for you", which would not be true.
            <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : profileQuery.isError || account === null ? (
            <ErrorState
              error={profileQuery.error}
              title="We could not load your details"
              onRetry={() => void profileQuery.refetch()}
            />
          ) : (
            <>
              <dl className="grid gap-4 sm:grid-cols-2">
                <DetailRow label="Name" value={customerName(account, account.email)} />
                <DetailRow label="Email" value={account.email} />
                <DetailRow label="Your timezone" value={account.timezone.replace(/_/g, ' ')} />
                <DetailRow label="Account type" value={humanizeEnum(account.platformRole)} />
              </dl>

              {account.emailVerified ? (
                <p className="flex items-start gap-2 text-sm text-success-text">
                  <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Your email address is confirmed, which is what lets MeetFlow gather your bookings
                  from every business under this one account.
                </p>
              ) : (
                <p className="flex items-start gap-2 text-sm text-warning-text">
                  <MailWarning className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  Your email address has not been confirmed yet. Until it is, bookings you made
                  before creating this account stay separate from it — matching on an unproven
                  address would let anyone read your diary by typing it at sign-up. The confirmation
                  link was sent when the account was created.
                </p>
              )}

              <p className="text-sm text-fg-muted">
                Your name, phone number and timezone travel with each booking and are held by the
                business you booked with. Ask them to change either, or set how they contact you in{' '}
                <Link
                  to="/portal/preferences"
                  className="rounded-xs font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  Preferences
                </Link>
                .
              </p>
            </>
          )}
        </CardBody>
      </Card>

      {/* --- Businesses that hold a record ----------------------------------- */}
      <Card>
        <CardHeader
          as="h2"
          title="Businesses you book with"
          description="Everywhere your bookings are gathered from."
        />
        <CardBody>
          {profileQuery.isPending ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : profileQuery.data && profileQuery.data.workspaces.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {profileQuery.data.workspaces.map((workspace) => (
                <li
                  key={workspace.customerPublicId}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-4 py-3"
                >
                  {workspace.business.logoUrl ? (
                    <img
                      src={workspace.business.logoUrl}
                      alt=""
                      className="size-8 shrink-0 rounded-md object-cover"
                    />
                  ) : (
                    <Store className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="truncate text-sm font-medium text-fg">
                      {workspace.business.name}
                    </p>
                    <p className="text-xs text-fg-muted">
                      Known to them since{' '}
                      {formatDate(
                        workspace.knownSince,
                        account?.timezone ?? workspace.business.timezone,
                      )}
                    </p>
                  </div>
                  {workspace.upcomingBookings > 0 ? (
                    <Badge tone="brand">{workspace.upcomingBookings} upcoming</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">
              No business holds a customer record for this account yet. One appears here the first
              time you book with the address above.
            </p>
          )}
        </CardBody>
      </Card>

      {/* --- Workspaces this account works in --------------------------------
          Rendered only when there are any. A pure customer has none, and an
          empty "Workspaces" card would leave them wondering what they are
          missing. */}
      {memberships.length > 0 ? (
        <Card>
          <CardHeader
            as="h2"
            title="Workspaces you work in"
            description="Where this account can sign in and manage a diary."
          />
          <CardBody>
            <ul className="flex flex-col gap-3">
              {memberships.map((membership) => (
                <li
                  key={membership.membershipId}
                  className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-4 py-3"
                >
                  <Building2 className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="truncate text-sm font-medium text-fg">
                      {membership.businessName}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {roleLabel(membership.roleKey, membership.roleName)} ·{' '}
                      {membership.timezone.replace(/_/g, ' ')}
                    </p>
                  </div>
                  {membership.businessId === activeBusinessId ? (
                    <Badge tone="brand">Current</Badge>
                  ) : null}
                  <Badge tone={membership.status === 'ACTIVE' ? 'success' : 'warning'}>
                    {humanizeEnum(membership.status)}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {/* --- Password -------------------------------------------------------- */}
      <Card>
        <CardHeader
          as="h2"
          title="Change your password"
          description="Changing it signs you out of every device, including this one."
        />
        <form onSubmit={onChangePassword} noValidate>
          <CardBody className="flex max-w-lg flex-col gap-4">
            <FormBanner message={formError} />

            <Field
              label="Current password"
              required
              error={form.formState.errors.currentPassword?.message}
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  {...form.register('currentPassword')}
                  type={showCurrent ? 'text' : 'password'}
                  autoComplete="current-password"
                  trailingSlot={
                    <button
                      type="button"
                      onClick={() => setShowCurrent((current) => !current)}
                      aria-label={showCurrent ? 'Hide current password' : 'Show current password'}
                      aria-pressed={showCurrent}
                      className="rounded-md p-1 text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {showCurrent ? (
                        <EyeOff className="size-4" aria-hidden="true" />
                      ) : (
                        <Eye className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  }
                />
              )}
            </Field>

            <Field
              label="New password"
              required
              error={form.formState.errors.newPassword?.message}
              hint={<PasswordChecklist value={newPassword} />}
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  {...form.register('newPassword')}
                  type={showNew ? 'text' : 'password'}
                  autoComplete="new-password"
                  trailingSlot={
                    <button
                      type="button"
                      onClick={() => setShowNew((current) => !current)}
                      aria-label={showNew ? 'Hide new password' : 'Show new password'}
                      aria-pressed={showNew}
                      className="rounded-md p-1 text-fg-muted transition-colors hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    >
                      {showNew ? (
                        <EyeOff className="size-4" aria-hidden="true" />
                      ) : (
                        <Eye className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  }
                />
              )}
            </Field>

            <Field
              label="Repeat the new password"
              required
              error={form.formState.errors.confirmPassword?.message}
            >
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  {...form.register('confirmPassword')}
                  type="password"
                  autoComplete="new-password"
                />
              )}
            </Field>

            <p className="text-sm text-fg-muted">
              Forgotten it instead?{' '}
              <Link
                to="/forgot-password"
                className="rounded-xs font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                Reset it by email
              </Link>
              .
            </p>
          </CardBody>
          <CardFooter>
            <Button
              type="submit"
              loading={form.formState.isSubmitting}
              leadingIcon={<KeyRound className="size-4" aria-hidden="true" />}
            >
              Change password
            </Button>
          </CardFooter>
        </form>
      </Card>

      {/* --- Sessions -------------------------------------------------------- */}
      <Card>
        <CardHeader
          as="h2"
          title="Sessions"
          description="Signed in somewhere you should not be? End every session at once."
        />
        <CardBody className="flex flex-col gap-3">
          <p className="flex items-start gap-2 text-sm leading-relaxed text-fg-secondary">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-hidden="true" />
            This revokes every refresh token on your account. Anything still holding one — another
            browser, a phone, a tab you forgot about — is signed out, and so is this one.
          </p>
          <div>
            <Button
              variant="danger"
              leadingIcon={<LogOut className="size-4" aria-hidden="true" />}
              onClick={() => setSignOutAllOpen(true)}
            >
              Sign out everywhere
            </Button>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={signOutAllOpen}
        onCancel={() => setSignOutAllOpen(false)}
        onConfirm={() => signOutEverywhere.mutate()}
        title="Sign out of every device?"
        description="You will need to sign in again here as well as everywhere else. Nothing about your bookings changes."
        confirmLabel="Sign out everywhere"
        cancelLabel="Stay signed in"
        destructive
        loading={signOutEverywhere.isPending}
      />
    </>
  );
}
