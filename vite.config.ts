import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
