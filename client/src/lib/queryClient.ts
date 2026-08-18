import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './apiClient';

/**
 * Retrying a 4xx is always wrong: the request itself is the problem, so the
 * second attempt fails identically while doubling the delay before the user
 * sees the error. It is also actively harmful on this API, whose auth and
 * booking endpoints are rate limited per IP.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (!isApiError(error)) return false;
  if (error.code === 'REQUEST_ABORTED') return false;
  // 429 included deliberately: the bucket needs time, not another attempt.
  if (error.status >= 400 && error.status < 500) return false;
  return true;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
        // Scheduling data changes under you — a colleague books a slot while
        // you look at it — so a short window, backed by socket invalidation.
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: {
        // A booking that may have succeeded must never be replayed blindly.
        retry: false,
      },
    },
  });
}
