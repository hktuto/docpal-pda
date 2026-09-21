# Backend production image. Build context: repo root
#   docker build -f apps/backend/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.28.2 --activate
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/backend/package.json apps/backend/
RUN pnpm install --filter @warehouse/backend... --frozen-lockfile

COPY apps/backend apps/backend
RUN pnpm --filter @warehouse/backend build \
  && pnpm --filter @warehouse/backend deploy --legacy --prod /deploy \
  && cp -r apps/backend/dist /deploy/dist \
  && cp -r apps/backend/drizzle /deploy/drizzle \
  && cp apps/backend/src/db/seed-parts-data.json /deploy/dist/db/seed-parts-data.json

FROM node:22-alpine
WORKDIR /app
COPY --from=build /deploy .
ENV NODE_ENV=production \
    PORT=3002
EXPOSE 3002
# Migrations (dist/../drizzle) auto-apply at boot; demo dataset auto-seeds when
# the users table is empty unless WAREHOUSE_SEED=off.
CMD ["node", "dist/server.js"]
