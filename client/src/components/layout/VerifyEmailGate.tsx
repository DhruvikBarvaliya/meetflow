import { useMutation } from '@tanstack/react-query';
import { MailCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, buttonStyles } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useToast } from '@/components/ui/Toaster';
import { useAuth } from '@/context/AuthContext';
import { api, isApiError } from '@/lib/apiClient';

/**
 * What a signed-in person sees before they have confirmed their address.
 *
 * The server refuses every authenticated surface except `/auth` with a 403
 * carrying `EMAIL_NOT_VERIFIED`. Without this screen the user meets that as a
 * generic failure on whichever page they happened to open — and the remedy, a
 * link sent to their inbox, is nowhere in sight.
 *
 * Rendered in place rather than as a redirect, matching how the permission
 * refusal behaves one level down in `ProtectedRoute`: the address bar keeps
 * saying what they asked for, so verifying and reloading lands them where they
 * were going instead of on a dashboard they then have to navigate out of.
 *
 * The address is spelled out because the most common reason for being here is
 * that it is wrong. Somebody who mistyped their own address will never receive
 * anything, however many times they press the button, and seeing the typo is
 * the only thing that helps.
 */
export function VerifyEmailGate(): JSX.Element {
  const { user, logout } = useAuth();
  const { toast } = useToast();

  const resend = useMutation({
    mutationFn: () => api.post('/auth/verification/resend'),
    onSuccess: () => {
      // The server answers the same whether it sent one, declined inside the
      // cooldown, or found the account already verified — so this message is
      // written to be true in all three cases rather than promising an email
      // that may not have been sent.
      toast({
        tone: 'success',
        title: 'On its way',
        description: 'If your address still needs confirming, a new link is on its way to it.',
      });
    },
    onError: (error: unknown) => {
      toast({
        tone: 'error',
        title: 'Could not send it',
        description: isApiError(error)
          ? error.message
          : 'Something went wrong sending that link. Try again in a moment.',
      });
    },
  });

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <EmptyState
        icon={<MailCheck className="size-6" aria-hidden="true" />}
        title="Confirm your email address"
        description={
          <>
            We sent a link to <strong>{user?.email}</strong> when you registered. Opening it
            finishes setting up your account.
            <br />
            If that address is not right, sign out and register again — a link sent to the wrong
            address will never arrive.
          </>
        }
        action={
          <Button onClick={() => resend.mutate()} loading={resend.isPending}>
            Send another link
          </Button>
        }
        secondaryAction={
          <Link to="/login" className={buttonStyles('ghost', 'md')} onClick={() => void logout()}>
            Sign out
          </Link>
        }
      />
    </div>
  );
}
