/**
 * The browser's copy of the session.
 *
 * Deliberately framework-free: `apiClient` needs the tokens inside an axios
 * interceptor, which runs far outside React's render tree, so this cannot be
 * React state. Contexts subscribe to it instead.
 *
 * Storage choice, and its trade-off: the API also sets the refresh token as an
 * httpOnly cookie, which is strictly safer. We persist it here as well because
 * the cookie is only usable when the app and the API are same-site — true
 * behind the dev proxy, not guaranteed for every deployment — and because the
 * body value is the contract the server documents for non-cookie clients. The
 * server prefers the body value when both are present, so the two never
 * disagree.
 */

const ACCESS_TOKEN_KEY = 'meetflow.accessToken';
const REFRESH_TOKEN_KEY = 'meetflow.refreshToken';
const BUSINESS_ID_KEY = 'meetflow.activeBusinessId';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

type Listener = () => void;

/**
 * Reading `localStorage` throws in Safari private mode and wherever storage is
 * blocked by policy. Failing to sign in is a far worse outcome than failing to
 * persist, so every access degrades to in-memory only.
 */
function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // In-memory state below is still correct; only persistence is lost.
  }
}

let accessToken: string | null = safeRead(ACCESS_TOKEN_KEY);
let refreshToken: string | null = safeRead(REFRESH_TOKEN_KEY);
let activeBusinessId: string | null = safeRead(BUSINESS_ID_KEY);

const tokenListeners = new Set<Listener>();
const expiryListeners = new Set<Listener>();

function notify(listeners: Set<Listener>): void {
  for (const listener of listeners) listener();
}

export const session = {
  getAccessToken(): string | null {
    return accessToken;
  },

  getRefreshToken(): string | null {
    return refreshToken;
  },

  hasSession(): boolean {
    return accessToken !== null && refreshToken !== null;
  },

  getActiveBusinessId(): string | null {
    return activeBusinessId;
  },

  setTokens(tokens: SessionTokens): void {
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
    safeWrite(ACCESS_TOKEN_KEY, tokens.accessToken);
    safeWrite(REFRESH_TOKEN_KEY, tokens.refreshToken);
    notify(tokenListeners);
  },

  setActiveBusinessId(businessId: string | null): void {
    if (activeBusinessId === businessId) return;
    activeBusinessId = businessId;
    safeWrite(BUSINESS_ID_KEY, businessId);
  },

  clear(): void {
    accessToken = null;
    refreshToken = null;
    activeBusinessId = null;
    safeWrite(ACCESS_TOKEN_KEY, null);
    safeWrite(REFRESH_TOKEN_KEY, null);
    safeWrite(BUSINESS_ID_KEY, null);
    notify(tokenListeners);
  },

  /** Fires whenever the access token changes — including after a refresh. */
  onTokensChanged(listener: Listener): () => void {
    tokenListeners.add(listener);
    return () => tokenListeners.delete(listener);
  },

  /**
   * Fires when the session is beyond recovery (refresh rejected). Subscribers
   * clear their own caches and send the user to /login.
   */
  onExpired(listener: Listener): () => void {
    expiryListeners.add(listener);
    return () => expiryListeners.delete(listener);
  },

  /** Called by the API client once a refresh has definitively failed. */
  expire(): void {
    const hadSession = accessToken !== null || refreshToken !== null;
    session.clear();
    if (hadSession) notify(expiryListeners);
  },
} as const;
