import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// Two dev servers in one checkout would fight over the rooms' storage (SQLite allows one
// writer) and over the Worker debugger port. A second server needs its own storage folder:
//   ROOM_STATE_DIR=/tmp/farkle-rooms bun run dev --port 5174
// That also turns its debugger port off; the first server keeps the default (9229).
const roomStateDir = process.env.ROOM_STATE_DIR;
const devRuntime = roomStateDir ? { persistState: { path: roomStateDir }, inspectorPort: false as const } : {};

export default defineConfig({
  // The Cloudflare plugin runs the Worker and its Room Durable Object (worker/index.ts, set up
  // in cloudflare.config.ts) inside the dev server, and builds client + Worker together into
  // .cloudflare/output/ (not dist/). Unit tests don't need a Workers runtime.
  plugins: [react(), ...(process.env.VITEST ? [] : [cloudflare(devRuntime)])],
  build: {
    target: "es2022",
    // Rapier inlines its physics wasm (~2 MB raw), so vendor chunks are large by nature.
    chunkSizeWarningLimit: 2500,
    rolldownOptions: {
      output: {
        // Split vendors so game-code changes don't bust the big cached chunks.
        codeSplitting: {
          groups: [
            { name: "rapier", test: /node_modules[\\/]@dimforge/ },
            { name: "three", test: /node_modules[\\/]three/ },
            // React/xstate + Vite's preload helper stay out of `vendor`, so the setup screen
            // can paint without preloading three/rapier (GameCanvas is lazy-loaded).
            {
              name: "react",
              test: /vite[\\/]preload-helper|node_modules[\\/](react|react-dom|scheduler|xstate|@xstate|use-sync-external-store|use-isomorphic-layout-effect)[\\/]/,
            },
            { name: "vendor", test: /node_modules/ },
          ],
        },
      },
    },
  },
  test: {
    passWithNoTests: true,
  },
});
