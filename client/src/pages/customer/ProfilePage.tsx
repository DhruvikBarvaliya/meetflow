import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { Building2, Eye, EyeOff, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
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
  Field,
  Input,
  useToast,
} from '@/components/ui';
import { useAuth } from '@/context/AuthContext';
import { ApiError, api } from '@/lib/apiClient';
import { humanizeEnum } from '@/lib/format';
import { SYSTEM_ROLE_LABELS, isSystemRoleKey } from '@/lib/permissions';
import { FormBanner } from '@/pages/auth/FormBanner';
import { PasswordChecklist } from '@/pages/auth/PasswordChecklist';
import { passwordSchema } from '@/pages/auth/passwordSchema';
import { useFormApiError } from '@/pages/auth/useFormApiError';
import { useMyCustomer } from './useMyCustomer';

const changePasswordSchema = z
  .object({
    // Deliberately not the full policy: an existing password may pre-date a
    // rule change, and refusing to submit it would be a dead end.
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

export default function ProfilePage(): JSX.Element {
  const { user, memberships, activeBusinessId, logout } = useAuth();
  const { customer } = useMyCustomer();
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

  /**
   * Changing a password revokes every refresh token the account holds — the API
   * says so in its own response — so the only honest thing to do afterwards is
   * end this session too and send the user back to sign in.
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
        description: error instanceof ApiError ? error.message : 'Please try again in a moment.',
        tone: 'error',
      });
    },
  });

  return (
    <>
      <PageHeader
        title="My profile"
        description="Your account, the workspaces it belongs to, and the security of both."
      />

      {/* --- Account --------------------------------------------------------- */}
      <Card>
        <CardHeader
          as="h2"
          title="Account"
          description="Identity details the API holds against your login."
        />
        <CardBody>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">Email</dt>
              <dd className="text-sm text-fg">{user?.email ?? '—'}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                Account type
              </dt>
              <dd className="text-sm text-fg">{user ? humanizeEnum(user.platformRole) : '—'}</dd>
            </div>
            {customer ? (
              <>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                    Name on your bookings
                  </dt>
                  <dd className="text-sm text-fg">
                    {customer.firstName} {customer.lastName}
                  </dd>
                </div>
                <div className="flex flex-col gap-0.5">
                  <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">
                    Booking timezone
                  </dt>
                  <dd className="text-sm text-fg">
                    {(customer.timezone ?? '—').replace(/_/g, ' ')}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
          {customer ? (
            <p className="mt-4 text-sm text-fg-muted">
              Your name, phone number and timezone travel with your bookings.{' '}
              <Link
                to="/app/preferences"
                className="rounded-xs font-medium text-brand-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                Change them in Preferences
              </Link>
              .
            </p>
          ) : null}
        </CardBody>
      </Card>

      {/* --- Workspaces ------------------------------------------------------ */}
      <Card>
        <CardHeader
          as="h2"
          title="Workspaces"
          description="Where this account can sign in, and what it may do there."
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
                  <p className="truncate text-sm font-medium text-fg">{membership.businessName}</p>
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
        description="You will need to sign in again here as well as everywhere else."
        confirmLabel="Sign out everywhere"
        cancelLabel="Stay signed in"
        destructive
        loading={signOutEverywhere.isPending}
      />
    </>
  );
}
