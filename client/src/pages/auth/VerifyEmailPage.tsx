/**
 * Confirming an email address.
 *
 * `POST /auth/verify-email` is sent by every registration and every invitation,
 * and until now the link in those emails led to the not-found page. The address
 * in the email is built by `notification.service.ts` as
 * `${PUBLIC_APP_URL}/verify-email?token=…`, so this page must be mounted at
 * `/verify-email` and must read `token` from the query string.
 *
 * **Why the page submits on its own rather than showing a button.** Opening
 * the link *is* the consent — the person was asked to confirm the address and
 * did. A confirm button would add a step that means nothing and would strand
 * anyone who closed the tab thinking they were done. It is safe to do
 * automatically for one specific reason: verification is a POST, and the link
 * scanners that prefetch URLs in corporate mail gateways issue GETs. A page
 * that verified on GET would be marked verified by the scanner before the
 * person ever saw the email, which is exactly what the server's choice of verb
 * prevents — so this page must never move the call to a GET.
 *
 * **The token is single-use, which makes the double-submit guard load-bearing.**
 * React's StrictMode runs effects twice in development, and a browser that
 * replays the request would do the same in production. The second call cannot
 * succeed: the server clears `emailVerificationTokenHash` on the first one, so
 * the replay answers "invalid or already used" and would show a failure to
 * somebody whose address was verified a millisecond earlier. The ref below is
 * what stops that, and it is not a tidiness measure.
 *
 * Verifying is also what connects a person's existing bookings to their
 * account: `portal.service.ts` links unclaimed `Customer` rows by email only
 * once `emailVerifiedAt` is set, and refuses to before. The success state says
 * so, because that is the thing the reader actually gains.
 */
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, LinkIcon, MailWarning } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { buttonStyles } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { api, isApiError } from '@/lib/apiClient';
import { useAuth } from '@/context/AuthContext';
import { AuthLayout } from './AuthLayout';

interface VerifyEmailResult {
  verified: boolean;
}

export default function VerifyEmailPage(): JSX.Element {
  const [searchParams] = useSearchParams();
  const { status, memberships, refreshIdentity } = useAuth();
  const token = searchParams.get('token') ?? '';
  const hasToken = token.length > 0;

  // One attempt per mounted page, whatever React or the browser does with the
  // effect. See the header comment — a second attempt cannot succeed.
  const attempted = useRef(false);

  const verify = useMutation<VerifyEmailResult, unknown, string>({
    // `anonymous`: an invitee following this link has no session at all, and a
    // signed-in visitor's token is irrelevant to it. The endpoint identifies the
    // account from the token in the body and nothing else.
    mutationFn: (value) =>
      api.post<VerifyEmailResult>('/auth/verify-email', { token: value }, { anonymous: true }),
    retry: false,
    // The cached identity still says unverified, and every guarded route reads
    // it. Without this a person who has just confirmed their address is shown
    // the "confirm your address" screen until they reload by hand — at exactly
    // the moment they are watching.
    onSuccess: () => {
      if (status === 'authenticated') void refreshIdentity();
    },
  });

  const { mutate } = verify;

  useEffect(() => {
    if (!hasToken || attempted.current) return;
    attempted.current = true;
    mutate(token);
  }, [hasToken, token, mutate]);

  // --- The link arrived without its token ----------------------------------
  if (!hasToken) {
    return (
      <AuthLayout
        title="This link is incomplete"
        description="The address in the bar is missing the part that identifies your account."
      >
        <div className="flex flex-col gap-4">
          <span
            className="flex size-10 items-center justify-center rounded-full bg-warning-subtle text-warning-text"
            aria-hidden="true"
          >
            <LinkIcon className="size-5" />
          </span>
          <p className="text-sm leading-relaxed text-fg">
            Email programs sometimes break a long link across two lines, and only the first half
            gets opened. Copying the whole link out of the email will work.
          </p>
          <Link to="/login" className={buttonStyles('primary', 'lg')}>
            Go to sign in
          </Link>
        </div>
      </AuthLayout>
    );
  }

  // --- Working -------------------------------------------------------------
  if (verify.isPending || verify.isIdle) {
    return (
      <AuthLayout title="Confirming your email address" description="This takes a moment.">
        <div className="flex items-center gap-3" role="status" aria-live="polite">
          <Spinner size="sm" label={null} />
          <p className="text-sm text-fg-secondary">Checking your link…</p>
        </div>
      </AuthLayout>
    );
  }

  // --- Verified ------------------------------------------------------------
  if (verify.isSuccess) {
    return (
      <AuthLayout
        title="Email confirmed"
        description="Your address is verified and your account is ready."
      >
        <div className="flex flex-col gap-4" role="status">
          <span
            className="flex size-10 items-center justify-center rounded-full bg-success-subtle text-success-text"
            aria-hidden="true"
          >
            <CheckCircle2 className="size-5" />
          </span>
          <p className="text-sm leading-relaxed text-fg">
            Confirming the address is also what lets MeetFlow put your existing bookings under this
            account. Anywhere you have booked with it, past and future, now shows up in one place.
          </p>
          {status === 'authenticated' ? (
            // Where "ready" actually is depends on who they are. Somebody who
            // holds a membership came here to run a workspace; somebody who
            // does not came for their own bookings, and the sentence above is
            // about those.
            memberships.length > 0 ? (
              <Link to="/app" className={buttonStyles('primary', 'lg')}>
                Go to your workspace
              </Link>
            ) : (
              <Link to="/portal" className={buttonStyles('primary', 'lg')}>
                See your bookings
              </Link>
            )
          ) : (
            <Link to="/login" className={buttonStyles('primary', 'lg')}>
              Sign in
            </Link>
          )}
        </div>
      </AuthLayout>
    );
  }

  // --- Refused -------------------------------------------------------------
  //
  // The server answers the same way for a link that was already used and one
  // that was never valid, and it is right to — the two are indistinguishable
  // once the hash is cleared. So the page names both possibilities rather than
  // picking one and being wrong half the time.
  const message = isApiError(verify.error)
    ? verify.error.message
    : 'We could not reach MeetFlow to check that link.';

  return (
    <AuthLayout
      title="We could not confirm that link"
      description="Nothing has gone wrong with your account."
      footer={
        <Link
          to="/login"
          className="font-medium text-brand-text underline-offset-4 hover:underline"
        >
          Go to sign in
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        <span
          className="flex size-10 items-center justify-center rounded-full bg-warning-subtle text-warning-text"
          aria-hidden="true"
        >
          <MailWarning className="size-5" />
        </span>

        <p className="text-sm leading-relaxed text-fg" role="alert">
          {message}
        </p>

        <p className="text-sm leading-relaxed text-fg-muted">
          A confirmation link works once. If you have opened this one before, your address is
          already verified and there is nothing left to do — sign in as normal. If you have never
          used it, ask whoever invited you to send a fresh invitation.
        </p>
      </div>
    </AuthLayout>
  );
}
