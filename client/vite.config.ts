import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Where the dev server forwards `/api` and `/socket.io`.
 *
 * Proxying rather than pointing the browser straight at :4000 keeps the client
 * same-origin in development, so there is no CORS preflight on every call and
 * the API's httpOnly refresh cookie stays first-party.
 *
 * `127.0.0.1`, not `localhost`, and deliberately so: Node resolves `localhost`
 * to `::1` first, while the API binds `0.0.0.0` (IPv4 only). On a machine with
 * anything else listening on IPv6 :4000 the proxy silently forwards there
 * instead — which presents as inexplicable 404s or 500s from an API that is
 * demonstrably healthy when curled directly.
 */
const API_PROXY_TARGET = process.env.VITE_DEV_API_PROXY_TARGET ?? 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // The API's CORS allowlist and PUBLIC_APP_URL both name :5173 exactly, so
    // silently falling back to :5174 would break auth in a confusing way.
    strictPort: true,
    proxy: {
      '/api': { target: API_PROXY_TARGET, changeOrigin: true },
      '/socket.io': { target: API_PROXY_TARGET, changeOrigin: true, ws: true },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
