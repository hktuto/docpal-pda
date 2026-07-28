# Admin console production image (Nuxt SPA served by the nitro node server).
# Build context: repo root
#   docker build -f apps/admin/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/admin/package.json apps/admin/
COPY layers/i18n/package.json layers/i18n/
RUN pnpm install --filter @warehouse/admin... --filter @warehouse/i18n-layer... --frozen-lockfile

COPY layers/i18n layers/i18n
COPY apps/admin apps/admin
RUN pnpm --filter @warehouse/admin build

FROM node:20-alpine
WORKDIR /app
COPY --from=build /repo/apps/admin/.output .
ENV NODE_ENV=production \
    PORT=3100
# apiBaseUrl is public runtime config — override at container start with
# NUXT_PUBLIC_API_BASE_URL (no rebuild needed).
EXPOSE 3100
CMD ["node", "server/index.mjs"]
