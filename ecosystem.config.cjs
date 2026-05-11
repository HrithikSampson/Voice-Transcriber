"use strict";

/**
 * PM2 process file for EC2/production. Install: `npm install -g pm2`
 *
 * Prerequisites on the instance:
 * - `bun` on PATH (server start uses Bun)
 * - `NODE_ENV` and app env vars (see packages/env); place `apps/server/.env`
 *   and `apps/web/.env.production` (or `.env.local`) before deploy.
 */

const path = require("node:path");

const root = path.resolve(__dirname);

module.exports = {
  apps: [
    {
      name: "better-t-app-server",
      cwd: path.join(root, "apps/server"),
      script: "dist/index.mjs",
      interpreter: "bun",
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production" },
    },
    {
      name: "better-t-app-web",
      cwd: path.join(root, "apps/web"),
      script: "npm",
      args: ["run", "start", "--", "-H", "0.0.0.0", "-p", "3000"],
      interpreter: "none",
      env: { NODE_ENV: "production" },
    },
  ],
};
