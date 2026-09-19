# ─────────────────────────────────────────────────────────────────────────
# DocFlow API — production image.
#
# IMPORTANT: this repo is NOT a pnpm workspace. apps/api and apps/web each
# have their own package.json + pnpm-lock.yaml. @docflow/shared is linked
# via "file:../../packages/shared" (a relative path, not a workspace
# protocol), so packages/shared must exist at that relative depth
# whenever pnpm install runs against apps/api/package.json.
#
# Build: docker build -f apps/api/Dockerfile -t docflow/api:tag .
# Run:   docker run -p 4000:4000 docflow/api:tag
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
RUN apk add --no-cache python3 make g++ openssl
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY --from=shared /repo/packages ./packages
COPY apps/api/package.json apps/api/pnpm-lock.yaml apps/api/pnpm-workspace.yaml ./apps/api/
WORKDIR /repo/apps/api
RUN --mount=type=cache,id=pnpm-store-api,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# ───────────────────────── Stage 3: build ─────────────────────────
FROM node:22-alpine AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY --from=deps /repo ./
COPY apps/api ./apps/api
WORKDIR /repo/apps/api
RUN npx prisma generate
RUN pnpm run build
RUN --mount=type=cache,id=pnpm-store-api,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ───────────────────────── Stage 4: runtime ───────────────────────
FROM node:22-alpine AS runtime
# OCRmyPDF + Tesseract OCR (tesseract-ocr-por / tesseract-ocr-data-por) para arquivo legal PDF/A (art. 52.º CIVA)
RUN apk add --no-cache \
    tini \
    wget \
    ocrmypdf \
    tesseract-ocr \
    tesseract-ocr-data-por \
    ghostscript \
    qpdf \
    unpaper \
    pngquant \
    vips
ENV NODE_ENV=production \
    PORT=4000 \
    NODE_OPTIONS="--enable-source-maps" \
    TESSDATA_PREFIX=/usr/share/tessdata
RUN addgroup -g 10001 -S docflow \
 && adduser  -u 10001 -S docflow -G docflow -h /repo -s /sbin/nologin
WORKDIR /repo/apps/api
COPY --from=build --chown=docflow:docflow /repo/apps/api/dist         ./dist
COPY --from=build --chown=docflow:docflow /repo/apps/api/node_modules ./node_modules
COPY --from=build --chown=docflow:docflow /repo/apps/api/prisma       ./prisma
COPY --from=build --chown=docflow:docflow /repo/apps/api/package.json ./package.json
COPY --from=build --chown=docflow:docflow /repo/packages              /repo/packages
COPY --chown=docflow:docflow apps/api/entrypoint.sh                   ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
RUN mkdir -p uploads && chown docflow:docflow uploads
USER docflow
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/api/v1/health | grep -q '"status":"ok"' || exit 1

ENTRYPOINT ["/sbin/tini", "--", "./entrypoint.sh"]
CMD ["node", "dist/src/main.js"]
