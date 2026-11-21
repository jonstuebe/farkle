# Farkle

A 3D dice game in the browser: Vite + React + TypeScript, Three.js (via React Three Fiber),
Rapier physics, hosted on Cloudflare Workers Static Assets.

## Scripts

| Command              | What it does                                         |
| -------------------- | ---------------------------------------------------- |
| `bun install`        | Install dependencies                                 |
| `bun run dev`        | Vite dev server with hot reload                      |
| `bun run test`       | Run tests (vitest)                                   |
| `bun run typecheck`  | Type-check with `tsc`                                |
| `bun run build`      | Type-check and build to `dist/`                      |
| `bun run preview:cf` | Build and serve `dist/` on the local Workers runtime |
| `bun run deploy`     | Build and deploy to Cloudflare                       |
