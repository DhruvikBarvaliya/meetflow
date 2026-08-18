import 'axios';

/**
 * Two private flags the API client stores on the request config itself.
 *
 * They have to live on the config rather than in a module-level map because
 * the response interceptor only ever receives the config back — it has no other
 * handle on the request that failed.
 */
declare module 'axios' {
  export interface AxiosRequestConfig {
    /** Suppresses the Authorization and X-Business-Id headers. */
    mfAnonymous?: boolean;
    /** Set once a request has been replayed with a refreshed access token. */
    mfRetried?: boolean;
  }
}
