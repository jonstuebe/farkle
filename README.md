# Farkle

A 3D dice game in the browser. Pass the device around, or invite friends with a link and take turns whenever you like.

Built with Vite, React and TypeScript, Three.js (via React Three Fiber) and Rapier physics. Online games run on a Cloudflare Worker with one Durable Object per room.

```bash
bun install
bun dev            # http://localhost:5173, the app and the Worker together
bun run test       # rules, room and UI logic tests (vitest)
bun run typecheck  # the app, then the Worker
bun run build      # typecheck, then a production build
bun run preview    # serve the build
bun run smoke      # online rooms end to end, against a running dev server
```

`bun dev` runs the Worker and its Durable Object inside the Vite dev server (through `@cloudflare/vite-plugin`), so online games work locally with nothing else to start. Rooms made in development are kept in `.cloudflare/state/`.

Only one dev server can use that folder at a time. To run a second one from the same checkout, give it its own:

```bash
ROOM_STATE_DIR=/tmp/farkle-rooms bun dev --port 5174
```

## Online rooms

- `src/net/protocol.ts` is the contract between the browser and the Worker: room codes, messages, the HTTP routes.
- `src/net/room.ts` is the server's logic as pure functions (seating, the lobby, applying a move, summaries, expiry), tested in `src/net/room.test.ts`.
- `worker/index.ts` is the `Room` Durable Object: storage, WebSockets and the expiry alarm around those functions.

A game is its starting input plus an append-only log of moves (`src/game/log.ts`). Players send what they want to do, the Room checks it's their turn, rolls the dice itself, and sends the new log entries to everyone. A player who comes back later gets the whole log and watches what they missed.

Rooms delete themselves when nobody touches them: a lobby after 7 days, a game in progress after 30, a finished game after 7.

`bun run smoke` plays through all of this over real WebSockets: a host and two guests, rules, turns, moves that must be refused, a disconnect and reconnect, a game to the end, a rematch, cancelling a lobby and a full lobby. It needs `bun dev` running, and takes the server's address if it isn't the default:

```bash
bun run smoke http://localhost:5174
```

When a room is cancelled or expires, the Room sends `refused` and then closes the socket. A client should treat `refused` as the end and hang up itself instead of waiting for that close: the local Workers runtime doesn't deliver it to a socket that has never sent anything ([cloudflare/workerd#8185](https://github.com/cloudflare/workerd/issues/8185)).

## Deploying

The site runs on Cloudflare Workers, deployed with the [`cf` CLI](https://developers.cloudflare.com/cf/). The Worker is set up in `cloudflare.config.ts`. There's no custom domain yet, so production is on the Worker's `workers.dev` URL.

- **By hand:** run `npx cf auth login` once, then `bun run deploy`.
- **Previews:** `npx cf previews deploy` puts up a Worker Preview with its own `workers.dev` URL and its own rooms. Production isn't affected.

To deploy on every push, connect the repo in Workers Builds (dashboard → Workers & Pages → farkle → Settings → Builds):

| Setting         | Value                               |
| --------------- | ----------------------------------- |
| Build command   | `bun run typecheck && bun run test` |
| Deploy command  | `npx cf deploy`                     |
| Preview command | `npx cf previews deploy`            |

`cf deploy` runs the Vite build itself, so the build command only gates the deploy on checks. Use `npx` rather than `bunx` because `cf` doesn't support running under Bun.

The build writes to `.cloudflare/output/`, not `dist/`: the app's files and the Worker's bundle side by side.
