import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { ErrorState } from '@/components/ui/ErrorState';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * The last line of defence against a render-time crash.
 *
 * Without it, one thrown error in one component unmounts the entire React tree
 * and leaves a blank white page with no way back. This keeps the failure
 * visible and recoverable, and logs it at error level so it reaches whatever
 * collects console errors in production.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
        <div className="flex w-full max-w-lg flex-col items-center">
          <ErrorState error={error} title="MeetFlow hit an unexpected problem" />
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload MeetFlow
          </Button>
        </div>
      </div>
    );
  }
}
