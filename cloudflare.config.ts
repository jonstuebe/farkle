import { bindings, defineConfig, exports } from "cf/config";

import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "farkle",
    compatibilityDate: "2026-11-19",
    domains: ["farkle.jonstuebe.com"],
    // Production lives only on the custom domain. Previews (Workers Builds, one per branch/PR)
    // get their own *-farkle.<subdomain>.workers.dev URL. With a custom domain set, both default
    // to off, so they're set explicitly here; otherwise each deploy would flip the dashboard toggles back.
    workersDev: false,
    previewUrls: true,
    observability: {
      enabled: true,
    },
    // The Worker only serves online rooms (/api/*). Everything else is static assets.
    entrypoint,
    // The Worker reaches Room through ctx.exports, not an env binding. A binding names the
    // Worker (script_name), which may point a preview at production's rooms; ctx.exports gets
    // each preview its own storage.
    exports: {
      Room: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      // Signs turn alerts (Web Push, worker/webPush.ts). Set it once with
      // `npx cf workers secrets update VAPID_PRIVATE_KEY` (see README, Deploying); locally it
      // comes from .dev.vars. Without it the Room sends no alerts and everything else still
      // works. See scripts/vapid.ts.
      VAPID_PRIVATE_KEY: bindings.secret(),
    },
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
  },
});
