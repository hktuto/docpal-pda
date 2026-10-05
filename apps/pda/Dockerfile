# PDA production image (Nuxt SPA served by the nitro node server).
# Build context: repo root
#   docker build -f apps/pda/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Full workspace install: the app extends the shared layers via relative
# paths and their own deps must be present for the build.
COPY apps/pda/package.json apps/pda/
COPY layers/i18n/package.json layers/i18n/
COPY layers/app-update/package.json layers/app-update/
RUN pnpm install --filter @warehouse/pda... --filter @warehouse/i18n-layer... --filter @warehouse/app-update-layer... --frozen-lockfile

COPY layers/i18n layers/i18n
COPY layers/app-update layers/app-update
COPY apps/pda apps/pda
RUN pnpm --filter @warehouse/pda build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /repo/apps/pda/.output .
ENV NODE_ENV=production \
    PORT=3000
# apiBaseUrl is public runtime config — override at container start with
# NUXT_PUBLIC_API_BASE_URL (no rebuild needed).
EXPOSE 3000
CMD ["node", "server/index.mjs"]
