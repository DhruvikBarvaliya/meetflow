import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type InternalAxiosRequestConfig,
} from 'axios';
import type {
  ApiErrorBody,
  ApiErrorCode,
  ApiErrorDetail,
  ApiSuccess,
  AuthSession,
  Page,
  PageMeta,
} from '@/types/api';
import { session } from './session';

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

/**
 * Every failure the app can observe, in one shape.
 *
 * The API answers errors as `{ error: { code, message, details?, requestId } }`.
 * Network faults and aborts have no envelope at all, so they are normalised
 * into the same class with a synthetic code — callers should never have to ask
 * "is this an axios error or ours?".
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode | 'NETWORK_ERROR' | 'REQUEST_ABORTED';
  /** 0 when the request never reached the server. */
  readonly status: number;
  readonly details: ApiErrorDetail[];
  readonly requestId: string | null;
  readonly meta: Record<string, unknown> | null;

  constructor(init: {
    message: string;
    code: ApiError['code'];
    status: number;
    details?: ApiErrorDetail[];
    requestId?: string | null;
    meta?: Record<string, unknown> | null;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details ?? [];
    this.requestId = init.requestId ?? null;
    this.meta = init.meta ?? null;
  }

  /** Field-keyed messages, ready to hand to react-hook-form's `setError`. */
  get fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const detail of this.details) {
      if (detail.field && !(detail.field in result)) result[detail.field] = detail.message;
    }
    return result;
  }

  get isValidation(): boolean {
    return this.code === 'VALIDATION_FAILED';
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }

  /** Worth offering a retry button for: transient rather than the caller's fault. */
  get isRetryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  static from(error: unknown): ApiError {
    if (error instanceof ApiError) return error;

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<ApiErrorBody>;

      if (axiosError.code === 'ERR_CANCELED') {
        return new ApiError({
          message: 'The request was cancelled.',
          code: 'REQUEST_ABORTED',
          status: 0,
        });
      }

      const envelope = axiosError.response?.data?.error;
      if (envelope) {
        return new ApiError({
          message: envelope.message,
          code: envelope.code as ApiErrorCode,
          status: axiosError.response?.status ?? 0,
          details: envelope.details,
          requestId: envelope.requestId,
          meta: envelope.meta ?? null,
        });
      }

      const status = axiosError.response?.status ?? 0;
      return new ApiError({
        message:
          status === 0
            ? 'We could not reach MeetFlow. Check your connection and try again.'
            : 'Something went wrong. Please try again.',
        code: status === 0 ? 'NETWORK_ERROR' : 'INTERNAL_ERROR',
        status,
      });
    }

    return new ApiError({
      message: error instanceof Error ? error.message : 'Something went wrong. Please try again.',
      code: 'INTERNAL_ERROR',
      status: 0,
    });
  }
}

/** Narrowing helper for `catch` blocks and TanStack Query callbacks. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

export interface RequestOptions extends AxiosRequestConfig {
  /** Send without credentials — used for the `/public/*` booking surface. */
  anonymous?: boolean;
}

export const http: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  // Lets the API's httpOnly refresh cookie ride along when the two are same-site.
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * A second, interceptor-free instance for the refresh call itself.
 *
 * Refreshing through `http` would re-enter the 401 handler on failure and
 * recurse until the stack gave out.
 */
const refreshHttp: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  withCredentials: true,
  headers: { 'Content-Type': 'application/json' },
});

/** The public booking surface takes no auth, so it must not be sent any. */
function isPublicPath(url: string | undefined): boolean {
  return typeof url === 'string' && url.startsWith('/public');
}

/** Endpoints that establish a session; a 401 from these is the answer, not a hint. */
function isSessionEndpoint(url: string | undefined): boolean {
  if (typeof url !== 'string') return false;
  return (
    url.startsWith('/auth/login') ||
    url.startsWith('/auth/register') ||
    url.startsWith('/auth/refresh')
  );
}

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (config.mfAnonymous === true || isPublicPath(config.url)) return config;

  const accessToken = session.getAccessToken();
  if (accessToken) config.headers.set('Authorization', `Bearer ${accessToken}`);

  // Tenant selection. The server only ever uses this to choose among workspaces
  // the caller already belongs to, so an absent header simply means "the one
  // workspace I have".
  const businessId = session.getActiveBusinessId();
  if (businessId) config.headers.set('X-Business-Id', businessId);

  return config;
});

// ---------------------------------------------------------------------------
// Single-flight token refresh
// ---------------------------------------------------------------------------

let inFlightRefresh: Promise<string> | null = null;

async function performRefresh(): Promise<string> {
  const refreshToken = session.getRefreshToken();
  if (!refreshToken)
    throw new ApiError({ message: 'No session.', code: 'TOKEN_INVALID', status: 401 });

  const response = await refreshHttp.post<ApiSuccess<AuthSession>>('/auth/refresh', {
    refreshToken,
  });
  const next = response.data.data;
  session.setTokens({ accessToken: next.accessToken, refreshToken: next.refreshToken });
  return next.accessToken;
}

/**
 * Refreshes at most once for any number of concurrent 401s.
 *
 * Without this, a dashboard firing six queries at once would send six refresh
 * calls; the server rotates the refresh token on every use and treats reuse of
 * a rotated token as theft, so five of them would revoke the whole family and
 * sign the user out.
 */
function refreshAccessToken(): Promise<string> {
  inFlightRefresh ??= performRefresh().finally(() => {
    inFlightRefresh = null;
  });
  return inFlightRefresh;
}

http.interceptors.response.use(
  (response) => response,
  async (error: unknown) => {
    if (!axios.isAxiosError(error)) throw ApiError.from(error);

    const config: InternalAxiosRequestConfig | undefined = error.config;
    const status = error.response?.status;

    const isCredentialedCall =
      config !== undefined &&
      config.mfAnonymous !== true &&
      !isPublicPath(config.url) &&
      !isSessionEndpoint(config.url);

    const canRetry =
      status === 401 &&
      isCredentialedCall &&
      config.mfRetried !== true &&
      session.getRefreshToken() !== null;

    if (!canRetry) {
      // A 401 we cannot recover from on an authenticated call means the session
      // is gone; tell the app so it can clear caches and route to /login.
      if (status === 401 && isCredentialedCall) session.expire();
      throw ApiError.from(error);
    }

    config.mfRetried = true;
    try {
      const accessToken = await refreshAccessToken();
      config.headers.set('Authorization', `Bearer ${accessToken}`);
      return await http.request(config);
    } catch {
      session.expire();
      throw ApiError.from(error);
    }
  },
);

// ---------------------------------------------------------------------------
// Envelope-unwrapping helpers
// ---------------------------------------------------------------------------

function toAxiosConfig(options: RequestOptions = {}): AxiosRequestConfig {
  const { anonymous, ...rest } = options;
  return anonymous === true ? { ...rest, mfAnonymous: true } : rest;
}

async function request<T>(config: AxiosRequestConfig): Promise<ApiSuccess<T>> {
  try {
    const response = await http.request<ApiSuccess<T>>(config);
    // 204 No Content has no envelope at all; callers of a void endpoint (logout,
    // delete) never read `data`, so a synthetic one keeps the return type honest.
    if (response.status === 204) return { data: undefined as T };
    return response.data;
  } catch (error) {
    throw ApiError.from(error);
  }
}

/**
 * The API surface the rest of the app uses.
 *
 * Each verb has a plain form that yields the payload and a `…WithMeta` form for
 * the endpoints that also return `meta` (pagination, analytics ranges), so the
 * common case never has to reach through an envelope.
 */
export const api = {
  async get<T>(url: string, options?: RequestOptions): Promise<T> {
    return (await request<T>({ ...toAxiosConfig(options), method: 'GET', url })).data;
  },

  async getWithMeta<T>(url: string, options?: RequestOptions): Promise<ApiSuccess<T>> {
    return request<T>({ ...toAxiosConfig(options), method: 'GET', url });
  },

  /** For the paginated list endpoints, which return `T[]` plus a `PageMeta`. */
  async getPage<T>(url: string, options?: RequestOptions): Promise<Page<T>> {
    const response = await request<T[]>({ ...toAxiosConfig(options), method: 'GET', url });
    const meta = response.meta as unknown as PageMeta | undefined;
    return {
      items: response.data,
      meta: meta ?? {
        page: 1,
        pageSize: response.data.length,
        totalItems: response.data.length,
        totalPages: 1,
        hasNextPage: false,
      },
    };
  },

  async post<T>(url: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return (await request<T>({ ...toAxiosConfig(options), method: 'POST', url, data: body })).data;
  },

  async postWithMeta<T>(
    url: string,
    body?: unknown,
    options?: RequestOptions,
  ): Promise<ApiSuccess<T>> {
    return request<T>({ ...toAxiosConfig(options), method: 'POST', url, data: body });
  },

  async patch<T>(url: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return (await request<T>({ ...toAxiosConfig(options), method: 'PATCH', url, data: body })).data;
  },

  async put<T>(url: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return (await request<T>({ ...toAxiosConfig(options), method: 'PUT', url, data: body })).data;
  },

  async delete<T = void>(url: string, options?: RequestOptions): Promise<T> {
    return (await request<T>({ ...toAxiosConfig(options), method: 'DELETE', url })).data;
  },
} as const;
