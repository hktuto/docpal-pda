// PM2 ecosystem for the warehouse backend + admin console.
//
// First-time setup on the server (from the repo root):
//   pnpm install
//   cp apps/backend/.env.example apps/backend/.env   # edit DATABASE_URL etc.
//   pnpm --filter @warehouse/backend build           # tsc → apps/backend/dist
//   pnpm --filter @warehouse/admin build             # nuxt → apps/admin/.output
//
// Re-deploy after pulling changes:
//   pnpm install
//   pnpm --filter @warehouse/backend build && pm2 reload warehouse-backend
//   pnpm --filter @warehouse/admin build && pm2 reload warehouse-admin
//
// The backend auto-applies drizzle migrations on startup and seeds the demo
// dataset when the users table is empty (WAREHOUSE_SEED=off disables).

module.exports = {
  apps: [
    {
      name: "warehouse-backend",
      cwd: "apps/backend",
      script: "dist/server.js",
      watch: false,
      autorestart: true,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 3002,
        // DATABASE_URL / WAREHOUSE_CODE / CORS_ORIGINS come from
        // apps/backend/.env (loaded via dotenv) — or set them here to
        // override. Capacitor/web clients must reach this port.
      },
    },
    {
      name: "warehouse-admin",
      cwd: "apps/admin",
      script: ".output/server/index.mjs",
      watch: false,
      autorestart: true,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3100,
        // Browser-facing URL of the backend. "localhost" only works when the
        // browser runs on this machine — use the server's LAN IP otherwise:
        // NUXT_PUBLIC_API_BASE_URL: "http://<server-lan-ip>:3002",
      },
    },
  ],
};
