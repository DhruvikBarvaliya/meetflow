/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the REST API, including the version segment. Defaults to `/api/v1`. */
  readonly VITE_API_BASE_URL?: string;
  /** Socket.IO origin. Empty means same-origin, which the dev proxy forwards. */
  readonly VITE_SOCKET_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
