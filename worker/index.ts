import { DurableObject } from "cloudflare:workers";

import { secureRandomDie, type LogEntry } from "../src/game/log.ts";
import {
  CLOSE_CANCELLED,
  CLOSE_EXPIRED,
  CLOSE_REFUSED,
  isRoomCode,
  type Refusal,
  type ServerMessage,
} from "../src/net/protocol.ts";
import {
  applyMessage,
  cancellationOf,
  isDeviceId,
  isRoomIntent,
  lifetimeOf,
  parseClientMessage,
  parsePlayerName,
  presenceOf,
  seatAfterLeave,
  seat,
  summaryOf,
  viewOf,
  type LobbyRoom,
  type PlayingRoom,
  type Room as RoomState,
} from "../src/net/room.ts";

const ROOM_PATH = /^\/api\/rooms\/([A-Z0-9]+)\/(socket|summary|invite)$/;

const ROOM_KEY = "room";
const CODE_KEY = "code";

// The log is kept out of the stored room, one row per entry, so a move writes a row or two
// instead of rewriting the whole game (and a long game never outgrows one stored value).
type StoredRoom = LobbyRoom | Omit<PlayingRoom, "log">;

// Each socket carries its seat, so it survives the Room hibernating.
interface Attachment {
  seat: number;
}

const seatOf = (socket: WebSocket): number | null => {
  const attachment = socket.deserializeAttachment() as Partial<Attachment> | null;
  return typeof attachment?.seat === "number" ? attachment.seat : null;
};

const send = (socket: WebSocket, message: ServerMessage): void => {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    // Already closed.
  }
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

// One Room per invite code. Sockets use the hibernation API, so a game that sits for days
// between turns costs nothing while nobody is connected.
export class Room extends DurableObject<Env> {
  // The room as last loaded or saved. Gone when the Room hibernates, so it's read through load().
  private cached: RoomState | null | undefined;

  private load(): RoomState | null {
    if (this.cached !== undefined) return this.cached;
    const stored = this.ctx.storage.kv.get<StoredRoom>(ROOM_KEY);
    if (!stored) return (this.cached = null);
    if (stored.phase === "lobby") return (this.cached = stored);
    const log = this.ctx.storage.sql
      .exec<{ entry: string }>("SELECT entry FROM log WHERE game = ? ORDER BY seq", stored.gameNumber)
      .toArray()
      .map((row) => JSON.parse(row.entry) as LogEntry);
    return (this.cached = { ...stored, log });
  }

  // Every save pushes the Room's expiry back (see lifetimeOf).
  private async save(room: RoomState, appended: readonly LogEntry[] = []): Promise<void> {
    const before = this.cached;
    if (room.phase === "playing") {
      const { log: _log, ...stored } = room;
      // A new game (start or rematch) leaves the last game's log behind. The table is made
      // here, not when the Room wakes, so asking about a room that doesn't exist stores nothing.
      if (before?.phase !== "playing" || before.gameNumber !== room.gameNumber) {
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS log (game INTEGER NOT NULL, seq INTEGER NOT NULL, entry TEXT NOT NULL, PRIMARY KEY (game, seq))",
        );
        this.ctx.storage.sql.exec("DELETE FROM log");
      }
      for (const entry of appended) {
        this.ctx.storage.sql.exec(
          "INSERT INTO log (game, seq, entry) VALUES (?, ?, ?)",
          room.gameNumber,
          entry.seq,
          JSON.stringify(entry),
        );
      }
      this.ctx.storage.kv.put(ROOM_KEY, stored satisfies StoredRoom);
    } else {
      this.ctx.storage.kv.put(ROOM_KEY, room satisfies StoredRoom);
    }
    this.cached = room;
    await this.ctx.storage.setAlarm(Date.now() + lifetimeOf(room));
  }

  private code(): string {
    return this.ctx.storage.kv.get<string>(CODE_KEY) ?? "";
  }

  /** `closing`: a socket that is on its way out and shouldn't count as connected. */
  private presence(room: RoomState, closing?: WebSocket): boolean[] {
    const seats = this.ctx
      .getWebSockets()
      .filter((socket) => socket !== closing && socket.readyState === WebSocket.OPEN)
      .flatMap((socket) => seatOf(socket) ?? []);
    return presenceOf(room, seats);
  }

  private sendRoom(socket: WebSocket, room: RoomState): void {
    const seatIndex = seatOf(socket);
    if (seatIndex === null) return;
    send(socket, { type: "room", seat: seatIndex, room: viewOf(room, this.code(), this.presence(room)) });
  }

  private broadcast(message: ServerMessage, except?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket !== except) send(socket, message);
    }
  }

  private broadcastRoom(room: RoomState): void {
    for (const socket of this.ctx.getWebSockets()) this.sendRoom(socket, room);
  }

  // Nobody has touched the room for its whole lifetime.
  override async alarm(): Promise<void> {
    await this.end(CLOSE_EXPIRED, "Expired");
  }

  // A player looking at the room is told it's gone, the same way as a link to a room that
  // never existed. deleteAll also clears the alarm, and an empty Durable Object stops existing
  // once it shuts down.
  private async end(closeCode: number, reason: string): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      send(socket, { type: "refused", reason: "missing" });
      try {
        socket.close(closeCode, reason);
      } catch {
        // Already closed.
      }
    }
    await this.ctx.storage.deleteAll();
    this.cached = null;
  }

  private async cancel(device: string): Promise<Response> {
    const cancellation = cancellationOf(this.load(), device);
    if (cancellation === "notHost") return new Response("Not the host", { status: 403 });
    if (cancellation === "started") return new Response("Already started", { status: 409 });
    if (cancellation === "delete") await this.end(CLOSE_CANCELLED, "Cancelled");
    return new Response(null, { status: 204 });
  }

  private refuse(reason: Refusal): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    send(server, { type: "refused", reason });
    server.close(CLOSE_REFUSED, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [, code = "", route] = ROOM_PATH.exec(url.pathname) ?? [];
    const device = url.searchParams.get("device") ?? "";

    if (route === "summary") return json(summaryOf(this.load(), device));
    if (route === "invite") return this.cancel(device);

    const intent = url.searchParams.get("intent");
    if (!isDeviceId(device) || !isRoomIntent(intent)) return new Response("Bad request", { status: 400 });

    const before = this.load();
    const seating = seat(before, device, intent, parsePlayerName(url.searchParams.get("name")));
    // NOTE: nothing is written until the device has a seat, so a link to a room that doesn't
    // exist leaves no storage behind.
    if (!seating.ok) return this.refuse(seating.reason);

    const { room, seat: seatIndex } = seating;
    if (room !== before) {
      this.ctx.storage.kv.put(CODE_KEY, code);
      await this.save(room);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat: seatIndex } satisfies Attachment);

    if (room !== before) {
      // A new seat or a new name: everyone needs the room again.
      this.broadcastRoom(room);
    } else {
      this.sendRoom(server, room);
      this.broadcast({ type: "presence", connected: this.presence(room) }, server);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const message = parseClientMessage(data);
    const room = this.load();
    const seatIndex = seatOf(socket);
    if (!message || !room || seatIndex === null) return;

    const outcome = applyMessage(room, seatIndex, message, secureRandomDie);
    switch (outcome.kind) {
      case "ignored":
        return;
      case "rejected":
        // An out-of-turn move, or one made on an old screen: that player's screen catches up.
        this.sendRoom(socket, room);
        return;
      case "room":
        await this.save(outcome.room);
        this.broadcastRoom(outcome.room);
        return;
      case "appended":
        await this.save(outcome.room, outcome.entries);
        this.broadcast({ type: "appended", gameNumber: outcome.room.gameNumber, entries: outcome.entries });
        return;
      case "seen":
        await this.save(outcome.room);
        return;
      case "left":
        await this.save(outcome.room);
        for (const other of this.ctx.getWebSockets()) {
          const before = seatOf(other);
          if (before === null) continue;
          const after = seatAfterLeave(before, outcome.seat);
          if (after === null) {
            // Every socket of the device that left (it may have the lobby open twice). Without
            // a seat it gets no more messages.
            other.serializeAttachment({});
            try {
              other.close(1000, "Left");
            } catch {
              // Already closed.
            }
          } else if (after !== before) {
            other.serializeAttachment({ seat: after } satisfies Attachment);
          }
        }
        this.broadcastRoom(outcome.room);
        return;
    }
  }

  // Echoes the player's close. Codes like 1005 and 1006 only describe how a socket ended (no
  // code, or the connection just dropped, as when a phone suspends the app) and can't be sent
  // back, so those get a normal close.
  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    const isSendable = code === 1000 || (code >= 3000 && code <= 4999);
    try {
      socket.close(isSendable ? code : 1000);
    } catch {
      // Already closed.
    }
    this.left(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    this.left(socket);
  }

  private left(socket: WebSocket): void {
    const room = this.load();
    if (room) this.broadcast({ type: "presence", connected: this.presence(room, socket) }, socket);
  }
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    const [, code = "", route] = ROOM_PATH.exec(url.pathname) ?? [];

    if (!isRoomCode(code) || route === undefined) return new Response("Not found", { status: 404 });
    if (route === "summary" && request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (route === "invite" && request.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
    if (route === "socket" && request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket", { status: 426 });
    }
    if (route !== "socket" && !isDeviceId(url.searchParams.get("device") ?? "")) {
      return new Response("Bad request", { status: 400 });
    }

    const rooms = ctx.exports.Room;
    return rooms.get(rooms.idFromName(code)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
