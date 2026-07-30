# Web PDA production image (Nuxt SPA served by the nitro node server).
# Build context: repo root
#   docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Full workspace install: the app extends layers/i18n via a relative path and
# the layer's own deps (@nuxtjs/i18n) must be present for the build.
COPY apps/web/package.json apps/web/
COPY layers/i18n/package.json layers/i18n/
RUN pnpm install --filter @warehouse/web... --filter @warehouse/i18n-layer... --frozen-lockfile

COPY layers/i18n layers/i18n
COPY apps/web apps/web
RUN pnpm --filter @warehouse/web build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/apps/web/.output .
ENV NODE_ENV=production \
    PORT=3000
# apiBaseUrl is public runtime config — override at container start with
# NUXT_PUBLIC_API_BASE_URL (no rebuild needed).
EXPOSE 3000
CMD ["node", "server/index.mjs"]
