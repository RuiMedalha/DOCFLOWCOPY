# ─────────────────────────────────────────────────────────────────────────
# DocFlow Web (Next.js 15, output: "standalone"). Not a pnpm workspace
# member — its own package.json + pnpm-lock.yaml. @docflow/shared linked
# via "file:../../packages/shared". Next's standalone file-tracer can't
# follow a symlink pointing outside apps/web, so we replace it with a
# real copy before building.
# ─────────────────────────────────────────────────────────────────────────

# ───────────────────────── Stage 1: shared ────────────────────────
FROM node:22-alpine AS shared
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY packages/shared ./packages/shared
WORKDIR /repo/packages/shared
RUN pnpm install --no-frozen-lockfile --ignore-scripts
RUN pnpm run build

# ───────────────────────── Stage 2: deps ──────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY --from=shared /repo/packages ./packages
COPY apps/web/package.json apps/web/pnpm-lock.yaml apps/web/pnpm-workspace.yaml ./apps/web/
WORKDIR /repo/apps/web
RUN --mount=type=cache,id=pnpm-store-web,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ───────────────────────── Stage 3: build ─────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY --from=deps /repo ./
COPY apps/web ./apps/web
WORKDIR /repo/apps/web
RUN rm -rf node_modules/@docflow/shared \
 && cp -R /repo/packages/shared node_modules/@docflow/shared
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm run build

# ───────────────────────── Stage 4: runtime ───────────────────────
FROM node:22-alpine AS runtime
RUN apk add --no-cache tini wget
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -g 10001 -S docflow \
 && adduser  -u 10001 -S docflow -G docflow -h /app -s /sbin/nologin
WORKDIR /app
COPY --from=build --chown=docflow:docflow /repo/apps/web/.next/standalone ./
COPY --from=build --chown=docflow:docflow /repo/apps/web/.next/static ./.next/static
COPY --from=build --chown=docflow:docflow /repo/apps/web/public       ./public
USER docflow
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
