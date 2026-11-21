/**
 * An in-memory stand-in for the Room Durable Object, for tests. It runs the real room rules
 * (./room.ts) and speaks the real protocol (./protocol.ts) over fake sockets, so the online
 * session can be exercised without a Workers runtime.
 *
 * Delivery is explicit, which keeps tests deterministic: what the client sends is handled at
 * once, but everything going to a client (open, messages, close) waits in a queue until
 * `run()` is called.
 */
import type { DieValue } from "../game/scoring";
import type { SocketLike } from "./onlineSession";
import { CLOSE_CANCELLED, CLOSE_EXPIRED, CLOSE_REFUSED, type ServerMessage } from "./protocol";
import {
  applyMessage,
  cancellationOf,
  parseClientMessage,
  parsePlayerName,
  presenceOf,
  seat as seatDevice,
  summaryOf,
  viewOf,
  type Room,
} from "./room";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export class FakeSocket implements SocketLike {
  readyState = CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Everything the client sent on this socket, parsed. */
  readonly sent: unknown[] = [];
  /** Set by the server once the device is seated. */
  seat: number | null = null;
  /** Closed by the client (`close()`), as opposed to by the server or the network. */
  closedByClient = false;

  constructor(
    readonly url: URL,
    private readonly server: FakeRoomServer,
  ) {}

  send(data: string): void {
    if (this.readyState !== OPEN) throw new Error("socket is not open");
    this.sent.push(JSON.parse(data));
    this.server.receive(this, data);
  }

  close(): void {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.closedByClient = true;
    this.server.dropped(this);
  }
}

export class FakeRoomServer {
  room: Room | null = null;
  /** Every socket ever created, in order. */
  readonly sockets: FakeSocket[] = [];
  /** When true, new sockets never open (a dead network). */
  offline = false;
  private readonly queue: (() => void)[] = [];

  constructor(
    readonly code: string,
    private readonly randomDie?: () => DieValue,
  ) {}

  /** Pass as `env.createSocket`. */
  createSocket = (url: string): FakeSocket => {
    const socket = new FakeSocket(new URL(url), this);
    this.sockets.push(socket);
    if (!this.offline) this.queue.push(() => this.accept(socket));
    return socket;
  };

  /** Deliver everything queued for clients (including what those deliveries cause). */
  run(): void {
    for (let guard = 0; this.queue.length > 0; guard++) {
      if (guard > 10_000) throw new Error("FakeRoomServer.run: runaway queue");
      this.queue.shift()!();
    }
  }

  get openSockets(): FakeSocket[] {
    return this.sockets.filter((s) => s.readyState === OPEN && s.seat !== null);
  }

  /** The newest socket of a device. */
  socketOf(device: string): FakeSocket | undefined {
    return [...this.sockets].reverse().find((s) => s.url.searchParams.get("device") === device);
  }

  summary(device: string) {
    return summaryOf(this.room, device);
  }

  /** The network drops this socket (no close code from the server). */
  drop(socket: FakeSocket, code = 1006): void {
    if (socket.readyState === CLOSED) return;
    socket.readyState = CLOSED;
    this.dropped(socket);
    this.queue.push(() => socket.onclose?.({ code }));
  }

  /** Send a raw message to one socket (to simulate odd server behaviour). */
  push(socket: FakeSocket, message: ServerMessage | string): void {
    const data = typeof message === "string" ? message : JSON.stringify(message);
    this.queue.push(() => {
      if (socket.readyState === OPEN) socket.onmessage?.({ data });
    });
  }

  /** The room's alarm fired: everyone is told it expired. */
  expire(): void {
    this.closeAll(CLOSE_EXPIRED);
  }

  /** `DELETE invite`. */
  cancel(device: string): boolean {
    if (cancellationOf(this.room, device) !== "delete") return false;
    this.closeAll(CLOSE_CANCELLED);
    return true;
  }

  // --- used by FakeSocket ------------------------------------------------------------------------

  receive(socket: FakeSocket, data: string): void {
    const message = parseClientMessage(data);
    if (!message || !this.room || socket.seat === null) return;
    const outcome = applyMessage(this.room, socket.seat, message, this.randomDie);
    switch (outcome.kind) {
      case "ignored":
        break;
      case "rejected":
        this.sendRoom(socket);
        break;
      case "room":
        this.room = outcome.room;
        for (const s of this.openSockets) this.sendRoom(s);
        break;
      case "appended":
        this.room = outcome.room;
        for (const s of this.openSockets) {
          this.push(s, { type: "appended", gameNumber: outcome.room.gameNumber, entries: outcome.entries });
        }
        break;
      case "seen":
        this.room = outcome.room;
        break;
    }
  }

  dropped(socket: FakeSocket): void {
    if (socket.seat === null) return;
    this.broadcastPresence();
  }

  // -----------------------------------------------------------------------------------------------

  private accept(socket: FakeSocket): void {
    if (socket.readyState !== CONNECTING) return;
    const params = socket.url.searchParams;
    const intent = params.get("intent") === "host" ? "host" : "join";
    const seating = seatDevice(this.room, params.get("device") ?? "", intent, parsePlayerName(params.get("name")));
    socket.readyState = OPEN;
    socket.onopen?.({});
    if (!seating.ok) {
      socket.onmessage?.({ data: JSON.stringify({ type: "refused", reason: seating.reason } satisfies ServerMessage) });
      if (socket.readyState === OPEN) {
        socket.readyState = CLOSED;
        socket.onclose?.({ code: CLOSE_REFUSED });
      }
      return;
    }
    const changed = seating.room !== this.room;
    this.room = seating.room;
    // One socket per seat: a newer connection replaces the older one.
    for (const other of this.openSockets) {
      if (other !== socket && other.seat === seating.seat) this.drop(other, 1000);
    }
    socket.seat = seating.seat;
    for (const s of this.openSockets) {
      if (s === socket || changed) this.sendRoom(s);
    }
    if (!changed) this.broadcastPresence(socket);
  }

  private presence(): boolean[] {
    return this.room ? presenceOf(this.room, this.openSockets.map((s) => s.seat!)) : [];
  }

  private sendRoom(socket: FakeSocket): void {
    if (!this.room || socket.seat === null) return;
    this.push(socket, { type: "room", seat: socket.seat, room: viewOf(this.room, this.code, this.presence()) });
  }

  private broadcastPresence(except?: FakeSocket): void {
    const connected = this.presence();
    for (const s of this.openSockets) if (s !== except) this.push(s, { type: "presence", connected });
  }

  private closeAll(code: number): void {
    this.room = null;
    for (const socket of this.sockets) {
      if (socket.readyState === CLOSED) continue;
      socket.readyState = CLOSED;
      socket.seat = null;
      this.queue.push(() => socket.onclose?.({ code }));
    }
  }
}
