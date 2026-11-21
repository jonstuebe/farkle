// Dev server for the HUD harness only: the app's own config runs the Cloudflare Worker, which
// takes over HTML routing (and room storage). Run from the repo root:
//   bunx vite --config src/ui/hud/dev/vite.config.ts --port 5392
//   open http://localhost:5392/src/ui/hud/dev/harness.html?scene=replay
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  appType: "mpa",
});
