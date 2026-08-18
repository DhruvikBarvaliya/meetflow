import { Compass } from 'lucide-react';
import { Link } from 'react-router-dom';
import { buttonStyles } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuth } from '@/context/AuthContext';

export default function NotFoundPage(): JSX.Element {
  const { status } = useAuth();
  // Sending a signed-out visitor to /app would only bounce them to /login with
  // a redirect target they never asked for.
  const home = status === 'authenticated' ? '/app' : '/login';

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
      <EmptyState
        icon={<Compass className="size-6" aria-hidden="true" />}
        title="This page does not exist"
        description="The link may be out of date, or the page may have moved."
        action={
          <Link to={home} className={buttonStyles('primary', 'md')}>
            {status === 'authenticated' ? 'Back to MeetFlow' : 'Go to sign in'}
          </Link>
        }
      />
    </div>
  );
}
