# =============================================================================
# MeetFlow web client image
# =============================================================================
# Build from the REPOSITORY ROOT — the npm workspace tree (root package.json,
# package-lock.json, server/, client/, e2e/) must be inside the context or
# `npm ci` cannot reproduce the lockfile:
#
#   docker build -f docker/client.Dockerfile --target production -t meetflow-client .
#
# Targets:
#   development  Vite dev server with HMR on 5173, used by docker-compose.yml,
#                which bind-mounts ./client over the copied sources.
#   production   `vite build` output served by nginx as static files.
#
# The production stage carries no Node runtime at all: the bundle is finished
# artwork, so shipping a toolchain alongside it only adds attack surface.
# =============================================================================

ARG NODE_IMAGE=node:20-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine


# -----------------------------------------------------------------------------
# deps — full workspace install, cached on the manifests alone
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps

ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
# The e2e workspace is part of the lockfile, so `npm ci` resolves Playwright
# even though this image never runs a browser. Skipping the download saves
# several hundred megabytes and removes a network dependency from the build.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
COPY e2e/package.json e2e/package.json

# `npm ci` validates the whole workspace tree against the lockfile, which is why
# all three workspace manifests are present even though only `client` is built.
RUN npm ci


# -----------------------------------------------------------------------------
# development
# -----------------------------------------------------------------------------
FROM deps AS development

ENV NODE_ENV=development

COPY tsconfig.base.json ./
COPY client/ client/

# docker-compose.yml mounts anonymous volumes at both node_modules paths. Docker
# seeds an anonymous volume from the image, so the directory has to exist here
# or the workspace-local half of the tree is mounted empty.
RUN mkdir -p /app/client/node_modules

EXPOSE 5173

# `vite --host` (see client/package.json) binds 0.0.0.0 instead of loopback, so
# the dev server is reachable from outside the container. The working directory
# stays at the workspace root so `npm --workspace` resolves.
CMD ["npm", "--workspace", "client", "run", "dev"]


# -----------------------------------------------------------------------------
# builder — vite build
# -----------------------------------------------------------------------------
FROM deps AS builder

# Vite inlines VITE_* values into the bundle at build time, so they are build
# arguments rather than runtime environment: one image per target environment.
# Only public endpoints belong here — anything secret would be readable by every
# visitor who opens devtools, so no secret may ever be passed as a build arg.
ARG VITE_API_BASE_URL
ARG VITE_SOCKET_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_SOCKET_URL=${VITE_SOCKET_URL}

# NODE_ENV stays at its default here: `vite build` already emits a production
# bundle, and forcing production would strip the devDependencies Vite needs.
COPY tsconfig.base.json ./
COPY client/ client/

RUN npm --workspace client run build


# -----------------------------------------------------------------------------
# production — static bundle behind nginx
# -----------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS production

# Replaces the stock server block wholesale: SPA history fallback, gzip, cache
# policy and security headers all live in docker/nginx.conf.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/client/dist /usr/share/nginx/html

EXPOSE 80

# nginx drains connections on SIGQUIT and hard-stops on SIGTERM. The base image
# already sets this; it is repeated so a base image change cannot silently turn
# every deploy into a connection reset.
STOPSIGNAL SIGQUIT

# /healthz is served by nginx itself (see nginx.conf) rather than probing
# index.html, so the probe stays true even while the bundle is being swapped.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --spider --tries=1 http://127.0.0.1/healthz || exit 1

CMD ["nginx", "-g", "daemon off;"]
