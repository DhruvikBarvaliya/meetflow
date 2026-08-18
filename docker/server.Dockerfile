# =============================================================================
# MeetFlow API / worker image
# =============================================================================
# Build from the REPOSITORY ROOT — the npm workspace tree (root package.json,
# package-lock.json, server/, client/, e2e/) must be inside the context or
# `npm ci` cannot reproduce the lockfile:
#
#   docker build -f docker/server.Dockerfile --target production -t meetflow-server .
#
# Targets:
#   development  full workspace install, sources present, tsx hot reload.
#                Used by docker-compose.yml, which bind-mounts ./server over
#                the copied sources and keeps node_modules in anonymous volumes.
#   production   runtime dependencies + compiled dist only, non-root, tini as
#                PID 1. Used by docker/docker-compose.prod.yml.
#
# Both the API and the worker run from this one image; they differ only in the
# command (dist/server.js vs dist/worker.js), so a deploy can never ship an API
# and a worker built from different commits.
# =============================================================================

ARG NODE_IMAGE=node:20-alpine


# -----------------------------------------------------------------------------
# base — everything both the toolchain and the runtime need
# -----------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base

# tini becomes PID 1. Node does not reap orphaned children and, as PID 1, does
# not get the kernel's default signal handlers — without an init, the SIGTERM
# that drives src/server.ts's graceful shutdown is simply dropped and every
# deploy ends in a 10s SIGKILL mid-request.
#
# tzdata ships the IANA zone database that Alpine omits. MeetFlow's core domain
# is timezone arithmetic (docs/TimezoneAndDST.md); a missing or stale zone is a
# double-booking, not a cosmetic defect.
RUN apk add --no-cache tini tzdata

# Containers are UTC; every timestamp is stored as timestamptz and converted at
# the edges, so the process must never inherit a local zone.
ENV TZ=UTC
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
# The e2e workspace is part of the lockfile, so `npm ci` resolves Playwright
# even though this image never runs a browser. Skipping the download saves
# several hundred megabytes and removes a network dependency from the build.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

ENTRYPOINT ["/sbin/tini", "--"]


# -----------------------------------------------------------------------------
# deps — full workspace install, cached on the manifests alone
# -----------------------------------------------------------------------------
# Only the package manifests are copied first: application edits then reuse this
# layer, and a dependency change is the only thing that reinstalls.
FROM base AS deps

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
COPY e2e/package.json e2e/package.json

# `npm ci` validates the whole workspace tree against the lockfile, which is why
# all three workspace manifests are present even though only `server` is built.
RUN npm ci


# -----------------------------------------------------------------------------
# development
# -----------------------------------------------------------------------------
FROM deps AS development

ENV NODE_ENV=development

COPY tsconfig.base.json ./
COPY server/ server/

# docker-compose.yml mounts anonymous volumes at both node_modules paths. Docker
# seeds an anonymous volume from the image, so the directory has to exist here
# or the workspace-local half of the tree is mounted empty.
RUN mkdir -p /app/server/node_modules

EXPOSE 4000

# The working directory stays at the workspace root: compose starts the worker
# with `npm --workspace server run dev:worker`, which only resolves from there.
CMD ["npm", "--workspace", "server", "run", "dev"]


# -----------------------------------------------------------------------------
# builder — TypeScript -> dist
# -----------------------------------------------------------------------------
FROM deps AS builder

# server/tsconfig.json extends the shared compiler contract one level up.
COPY tsconfig.base.json ./
COPY server/ server/

# tsconfig.build.json narrows the program to src/**/*.ts, so tests and the
# Vitest config never reach dist even if they survive .dockerignore.
RUN npm --workspace server run build


# -----------------------------------------------------------------------------
# prod-deps — runtime dependency tree, no toolchain
# -----------------------------------------------------------------------------
# Installed separately from `deps` rather than pruned out of it: `npm prune`
# leaves the removed packages in the layer history, so the devDependencies would
# still be pullable from the published image.
FROM base AS prod-deps

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY client/package.json client/package.json
COPY e2e/package.json e2e/package.json

# npm hoists to the workspace root, so /app/server/node_modules may legitimately
# not exist. It is created unconditionally to keep the COPY below valid.
RUN npm ci --omit=dev --workspace server --include-workspace-root \
    && npm cache clean --force \
    && mkdir -p /app/server/node_modules


# -----------------------------------------------------------------------------
# production
# -----------------------------------------------------------------------------
FROM base AS production

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# Ownership is set during COPY rather than by a later `chown -R`, which would
# duplicate the whole tree into an extra layer.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/server/node_modules ./server/node_modules
COPY --from=prod-deps --chown=node:node /app/server/package.json ./server/package.json
COPY --from=builder   --chown=node:node /app/server/dist ./server/dist

# The stock unprivileged user from the Node image (uid 1000). The application
# never writes to disk — logs go to stdout — so nothing here needs to be
# writable by the process.
USER node

WORKDIR /app/server

EXPOSE 4000

# /health is the liveness probe: it answers from process state only and never
# touches PostgreSQL or Redis, so a database blip cannot make Docker kill an
# otherwise healthy container. Readiness (/ready) is the load balancer's job.
# Implemented with node itself so the image needs neither curl nor wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# node is exec'd directly under tini — no npm or shell in between, so SIGTERM
# arrives at the process that knows how to drain in-flight requests.
CMD ["node", "dist/server.js"]
