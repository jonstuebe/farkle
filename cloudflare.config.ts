import { defineConfig, exports } from "cf/config";

import * as entrypoint from "./worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "farkle",
    compatibilityDate: "2026-11-19",
    // No custom domain yet: production is farkle.<subdomain>.workers.dev, and every preview
    // gets its own *-farkle.<subdomain>.workers.dev URL.
    workersDev: true,
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
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
  },
});
