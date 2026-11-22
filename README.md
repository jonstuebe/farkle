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

### Reactions

Players can send a quick emoji (one of eight in `REACTIONS`, sent by name, never as free text) in the lobby or during a game. The Room passes it to every other device in the room and to nobody else; it isn't stored, replayed, or counted in the log, and each socket can send at most one a second (faster ones are dropped).

### Turn alerts

A player who turns on alerts gets a Web Push notification when the game needs them and isn't open on their device: their turn comes up (`Ada banked 450. It's your turn.`), the final round reaches them (`Ada reached 10,250. Last turn!`), a game or rematch starts with them, or the game ends (`Ada wins with 10,250.`). Nothing is sent for each roll, and nothing to a device with the game open.

- The browser subscribes and POSTs `{device, subscription}` to `/api/rooms/:code/push` for each game it's seated in; DELETE with `{device}` turns them off. One subscription per device, the newest wins.
- `src/net/alerts.ts` decides who to tell and what it says (tested in `alerts.test.ts`). `worker/webPush.ts` sends it: the payload encrypted for the device (RFC 8291) and signed with the app's VAPID key (RFC 8292), with nothing but WebCrypto. It only ever posts to the browsers' push services (or localhost, for the smoke test). A subscription the push service says is gone (404/410) is deleted.
- The VAPID public key is in `src/net/protocol.ts`; the private key is the Worker secret `VAPID_PRIVATE_KEY`. `bun dev` reads it from `.dev.vars` (git-ignored):

  ```bash
  VAPID_PRIVATE_KEY=...   # .dev.vars
  ```

  Without it, everything works except that no alerts are sent. `bun scripts/vapid.ts` makes a new pair, but replacing the pair cuts off every device that already subscribed.

`bun run smoke` plays through all of this over real WebSockets: a host and two guests, rules, turns, moves that must be refused, a disconnect and reconnect, a game to the end, a rematch, cancelling a lobby, a guest leaving a lobby, a full lobby, reactions, and turn alerts (registration, and a push delivered to a stand-in push service the script runs on localhost, which checks the VAPID signature and decrypts it). It needs `bun dev` running, and takes the server's address if it isn't the default:

```bash
bun run smoke http://localhost:5174
```

When a room is cancelled or expires, the Room sends `refused` and then closes the socket. A client should treat `refused` as the end and hang up itself instead of waiting for that close: the local Workers runtime doesn't deliver it to a socket that has never sent anything ([cloudflare/workerd#8185](https://github.com/cloudflare/workerd/issues/8185)).

## Deploying

The site runs on Cloudflare Workers, deployed with the [`cf` CLI](https://developers.cloudflare.com/cf/). The Worker is set up in `cloudflare.config.ts`. There's no custom domain yet, so production is on the Worker's `workers.dev` URL.

- **By hand:** run `npx cf auth login` once, then `bun run deploy`.
- **Turn alerts:** once the Worker exists (after the first deploy), store the VAPID private key (the value in `.dev.vars`) as a Worker secret:

  ```bash
  npx cf workers secrets update VAPID_PRIVATE_KEY --worker farkle --type secret_text --text "$(grep VAPID_PRIVATE_KEY .dev.vars | cut -d= -f2-)"
  ```

  (The `cf` CLI has no `secret put`; this is its equivalent.) Also set `VAPID_SUBJECT` in `src/net/protocol.ts` to the site's real URL.
- **Previews:** `npx cf previews deploy` puts up a Worker Preview with its own `workers.dev` URL and its own rooms. Production isn't affected.

To deploy on every push, connect the repo in Workers Builds (dashboard → Workers & Pages → farkle → Settings → Builds):

| Setting         | Value                               |
| --------------- | ----------------------------------- |
| Build command   | `bun run typecheck && bun run test` |
| Deploy command  | `npx cf deploy`                     |
| Preview command | `npx cf previews deploy`            |

`cf deploy` runs the Vite build itself, so the build command only gates the deploy on checks. Use `npx` rather than `bunx` because `cf` doesn't support running under Bun.

The build writes to `.cloudflare/output/`, not `dist/`: the app's files and the Worker's bundle side by side.
