import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ToastProvider } from '@/components/ui/Toaster';
import { AuthProvider } from '@/context/AuthContext';
import { SocketProvider } from '@/context/SocketContext';
import { ThemeProvider } from '@/context/ThemeContext';
import { createQueryClient } from '@/lib/queryClient';
import { AppRoutes } from '@/routes';

/**
 * The provider tree, in the order the layers actually depend on each other:
 *
 *   ErrorBoundary  — outermost, so a crash inside any provider is still caught
 *   ThemeProvider  — owns `data-theme`; nothing below it renders unthemed
 *   QueryClient    — AuthProvider stores the identity as a query
 *   AuthProvider   — the session every page and the socket read from
 *   SocketProvider — connects only once authenticated
 *   ToastProvider  — inside auth so a toast can be raised from any page
 *   AppRoutes      — the router itself; route elements use the hooks above
 */
export default function App(): JSX.Element {
  // Created once per app instance rather than at module scope, so a remount in
  // development starts from a clean cache instead of another mount's data.
  const [queryClient] = useState(createQueryClient);

  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SocketProvider>
              <ToastProvider>
                <AppRoutes />
              </ToastProvider>
            </SocketProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
