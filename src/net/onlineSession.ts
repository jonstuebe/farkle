/**
 * The browser's connection to one online room: a `GameSession` (see ../game/session.ts) backed by
 * a WebSocket to the room's Durable Object, plus the lobby state and lobby actions.
 *
 *   const session = createOnlineSession({ code, deviceId, name, intent: "join" });
 *   session.open();                       // connects (deferred a tick, so StrictMode is cheap)
 *   session.getRoom();                    // { status, room, seat, error } for the lobby UI
 *   session.getState();                   // SessionState for <GameProvider> / Presenter
 *   session.close();                      // leave; no more reconnects
 *
 * Behaviour:
 *  - The server is authoritative. `room` messages replace everything we know; `appended` adds
 *    log entries. If an `appended` doesn't line up (gap, or another game number), we don't guess:
 *    the socket is dropped and reopened, and the server sends the whole room again.
 *  - `seenFrom` is the server's `seen[mySeat]` when a game is first received, so the replay starts
 *    where this player stopped watching, on any device. It stays fixed for that game number.
 *  - `markSeen` is monotonic and throttled; the latest position is also sent when the page is
 *    hidden and after a reconnect.
 *  - Lost connections are retried with backoff. Coming back to the tab, or the network coming
 *    back, retries at once; after a long time hidden (a phone waking up) the socket is replaced
 *    even if it still looks open, because it often isn't.
 *  - `refused` and the server's close codes are final: `error` says why and nothing reconnects.
 */
import type { GameInput } from "../game/machine";
import type { Intent, LogEntry } from "../game/log";
import type { GameSession, SessionState } from "../game/session";
import { cancelInvite } from "./api";
import {
  CLOSE_CANCELLED,
  CLOSE_EXPIRED,
  CLOSE_REFUSED,
  type ClientMessage,
  type Refusal,
  type RoomView,
  type ServerMessage,
} from "./protocol";

/** Why the room can't be used. Final: the session does not reconnect after one of these. */
export type RoomError = Refusal | "expired" | "cancelled";

export type ConnectionStatus =
  /** First connection attempt, nothing received yet. */
  | "connecting"
  | "open"
  /** Had the room, lost the socket, trying again. */
  | "reconnecting"
  /** Closed for good: by `close()` or because of `error`. */
  | "closed";

export interface OnlineRoomState {
  status: ConnectionStatus;
  /** Latest room from the server (kept while reconnecting). Null until the first one arrives. */
  room: RoomView | null;
  /** This device's seat. Null until the first room arrives. */
  seat: number | null;
  error: RoomError | null;
}

export type LobbyRules = Extract<ClientMessage, { type: "configure" }>["rules"];

export interface OnlineSession extends GameSession {
  readonly kind: "online";
  readonly code: string;
  getRoom(): OnlineRoomState;
  /** Start connecting. Safe to call more than once. */
  open(): void;
  /** Stop for good (leaving the screen). */
  close(): void;
  /** Host, lobby: change the rules. */
  configure(rules: LobbyRules): void;
  /** Host, lobby: start the game. */
  start(): void;
  /** After the game is over: ask for a new game with the same seats. */
  rematch(): void;
  /** Host, lobby: cancel the invite for everyone. Resolves false if the server said no. */
  cancel(): Promise<boolean>;
}

/** The parts of a WebSocket the session uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Whatever the environment's `setTimeout` returns; only ever handed back to `clearTimeout`. */
export type TimerHandle = number | object;

export type WakeEvent = "hidden" | "visible" | "online";

/** Everything the session needs from the outside world; tests replace all of it. */
export interface OnlineEnv {
  createSocket(url: string): SocketLike;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  now(): number;
  /** 0..1, for backoff jitter. */
  random(): number;
  /** Page visibility and network changes. Returns an unsubscribe function. */
  onWake(listener: (event: WakeEvent) => void): () => void;
  cancelInvite(code: string, deviceId: string): Promise<boolean>;
}

export interface OnlineSessionOptions {
  code: string;
  deviceId: string;
  name: string;
  /** `host` creates the room if it doesn't exist; `join` never does. */
  intent: "host" | "join";
  env?: Partial<OnlineEnv>;
}

const SOCKET_OPEN = 1;

export const CONNECT_TIMEOUT_MS = 8000;
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 10_000;
export const SEEN_THROTTLE_MS = 600;
/** Hidden for longer than this: replace the socket on return even if it looks open. */
export const STALE_AFTER_HIDDEN_MS = 20_000;

/** Delay before reconnect attempt `attempt` (0-based): exponential, capped, with jitter. */
export function reconnectDelay(attempt: number, random: number): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 10));
  return Math.round(base * (0.75 + 0.5 * random));
}

export function roomSocketUrl(
  code: string,
  params: { deviceId: string; name: string; intent: "host" | "join" },
  base: { protocol: string; host: string },
): string {
  const scheme = base.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams({ device: params.deviceId, name: params.name, intent: params.intent });
  return `${scheme}//${base.host}/api/rooms/${code}/socket?${query.toString()}`;
}

function browserEnv(): OnlineEnv {
  return {
    // SAFETY: a DOM WebSocket has every member of SocketLike; only its handler event types are wider.
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
    random: () => Math.random(),
    onWake(listener) {
      const onVisibility = () => listener(document.visibilityState === "hidden" ? "hidden" : "visible");
      const onHide = () => listener("hidden");
      const onShow = () => listener("visible");
      const onOnline = () => listener("online");
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onHide);
      window.addEventListener("pageshow", onShow);
      window.addEventListener("online", onOnline);
      return () => {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onHide);
        window.removeEventListener("pageshow", onShow);
        window.removeEventListener("online", onOnline);
      };
    },
    cancelInvite: (code, deviceId) => cancelInvite(code, deviceId),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Parses a text frame. Null for anything that isn't a message we know. */
export function parseServerMessage(data: unknown): ServerMessage | null {
  if (typeof data !== "string") return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(message)) return null;
  switch (message.type) {
    case "room": {
      const room = message.room;
      if (typeof message.seat !== "number" || !isObject(room) || !Array.isArray(room.seats)) return null;
      if (room.phase === "lobby") return isObject(room.rules) ? (message as ServerMessage) : null;
      if (room.phase !== "playing") return null;
      const ok = typeof room.gameNumber === "number" && isObject(room.input) && Array.isArray(room.log) && Array.isArray(room.seen);
      return ok ? (message as ServerMessage) : null;
    }
    case "appended":
      return typeof message.gameNumber === "number" && Array.isArray(message.entries) ? (message as ServerMessage) : null;
    case "presence":
      return Array.isArray(message.connected) ? (message as ServerMessage) : null;
    case "refused":
      return message.reason === "missing" || message.reason === "full" || message.reason === "started"
        ? (message as ServerMessage)
        : null;
    default:
      return null;
  }
}

export function createOnlineSession(options: OnlineSessionOptions): OnlineSession {
  const env: OnlineEnv = { ...browserEnv(), ...options.env };
  const { code, deviceId, name } = options;
  const listeners = new Set<() => void>();

  let intent = options.intent;
  let roomState: OnlineRoomState = { status: "connecting", room: null, seat: null, error: null };
  let sessionState: SessionState = {
    gameNumber: 0,
    input: { players: [] },
    log: [],
    mySeats: [],
    seenFrom: 0,
    connected: false,
    presence: null,
  };

  let opened = false;
  let closed = false;
  let socket: SocketLike | null = null;
  let attempt = 0;
  let connectTimer: TimerHandle | null = null;
  let retryTimer: TimerHandle | null = null;
  let stopWake: (() => void) | null = null;
  let hiddenAt: number | null = null;

  // Seen tracking for the current game.
  let wantSeen = 0;
  let sentSeen = 0;
  let lastSeenAt = Number.NEGATIVE_INFINITY;
  let seenTimer: TimerHandle | null = null;

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const setRoom = (patch: Partial<OnlineRoomState>) => {
    roomState = { ...roomState, ...patch };
  };
  const setSession = (patch: Partial<SessionState>) => {
    sessionState = { ...sessionState, ...patch };
  };

  const isOpen = () => socket !== null && socket.readyState === SOCKET_OPEN && roomState.status === "open";

  const send = (message: ClientMessage): boolean => {
    if (!isOpen()) return false;
    try {
      socket!.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  };

  const clearTimer = (handle: TimerHandle | null) => {
    if (handle !== null) env.clearTimeout(handle);
  };

  // --- seen ------------------------------------------------------------------------------------

  const flushSeen = () => {
    clearTimer(seenTimer);
    seenTimer = null;
    if (wantSeen <= sentSeen) return;
    if (!send({ type: "seen", seq: wantSeen })) return; // sent after the next `room`
    sentSeen = wantSeen;
    lastSeenAt = env.now();
  };

  const scheduleSeen = () => {
    if (wantSeen <= sentSeen || seenTimer !== null || !isOpen()) return;
    const wait = lastSeenAt + SEEN_THROTTLE_MS - env.now();
    if (wait <= 0) {
      flushSeen();
      return;
    }
    seenTimer = env.setTimeout(() => {
      seenTimer = null;
      flushSeen();
    }, wait);
  };

  // --- connection ------------------------------------------------------------------------------

  const detach = (target: SocketLike | null) => {
    if (!target) return;
    target.onopen = target.onmessage = target.onclose = target.onerror = null;
    try {
      target.close();
    } catch {
      // already closed
    }
  };

  const finish = (error: RoomError | null) => {
    closed = true;
    clearTimer(connectTimer);
    clearTimer(retryTimer);
    clearTimer(seenTimer);
    connectTimer = retryTimer = seenTimer = null;
    stopWake?.();
    stopWake = null;
    detach(socket);
    socket = null;
    setRoom({ status: "closed", error });
    setSession({ connected: false });
    notify();
  };

  const lost = () => {
    if (closed) return;
    clearTimer(connectTimer);
    clearTimer(seenTimer);
    connectTimer = seenTimer = null;
    detach(socket);
    socket = null;
    const wasOpen = roomState.status === "open";
    setRoom({ status: roomState.room ? "reconnecting" : "connecting" });
    setSession({ connected: false });
    if (retryTimer === null) {
      retryTimer = env.setTimeout(connect, reconnectDelay(attempt, env.random()));
      attempt += 1;
    }
    if (wasOpen) notify();
  };

  function connect(): void {
    clearTimer(retryTimer);
    retryTimer = null;
    if (closed || socket) return;
    let created: SocketLike;
    try {
      created = env.createSocket(roomSocketUrl(code, { deviceId, name, intent }, socketBase()));
    } catch {
      lost();
      return;
    }
    socket = created;
    connectTimer = env.setTimeout(() => {
      connectTimer = null;
      if (socket === created && roomState.status !== "open") lost();
    }, CONNECT_TIMEOUT_MS);
    created.onmessage = (event) => {
      if (socket !== created) return;
      const message = parseServerMessage(event.data);
      if (message) receive(message);
    };
    created.onclose = (event) => {
      if (socket !== created) return;
      if (event.code === CLOSE_EXPIRED) finish("expired");
      else if (event.code === CLOSE_CANCELLED) finish("cancelled");
      else if (event.code === CLOSE_REFUSED) finish(roomState.error ?? "missing");
      else lost();
    };
    created.onerror = () => {
      // A close event follows; if it doesn't (some browsers, before open), the timeout handles it.
    };
  }

  /** Drop the socket and get the whole room again right away. */
  const resync = () => {
    if (closed) return;
    clearTimer(retryTimer);
    retryTimer = null;
    clearTimer(connectTimer);
    connectTimer = null;
    detach(socket);
    socket = null;
    setRoom({ status: roomState.room ? "reconnecting" : "connecting" });
    setSession({ connected: false });
    notify();
    connect();
  };

  // --- messages --------------------------------------------------------------------------------

  const receiveRoom = (seat: number, room: RoomView) => {
    clearTimer(connectTimer);
    connectTimer = null;
    attempt = 0;
    // The room exists now; a later reconnect must never create a new one under the same code.
    intent = "join";
    const presence = room.seats.map((s) => s.connected);
    const mySeats = sessionState.mySeats.length === 1 && sessionState.mySeats[0] === seat ? sessionState.mySeats : [seat];

    if (room.phase === "lobby") {
      const input: GameInput = { players: room.seats.map((s) => s.name), rules: room.rules };
      setSession({ gameNumber: 0, input, log: [], mySeats, seenFrom: 0, connected: true, presence });
      wantSeen = sentSeen = 0;
    } else {
      const serverSeen = Math.max(0, Math.min(room.seen[seat] ?? 0, room.log.length));
      if (room.gameNumber !== sessionState.gameNumber || sessionState.gameNumber === 0) {
        // A game we haven't shown yet (first open, or a rematch): the replay starts at what the
        // server says this player has already watched.
        setSession({
          gameNumber: room.gameNumber,
          input: room.input,
          log: room.log,
          mySeats,
          seenFrom: serverSeen,
          connected: true,
          presence,
        });
        wantSeen = sentSeen = serverSeen;
      } else {
        // Same game after a reconnect or a rejected message: take the server's log, keep the rest.
        const sameLog = room.log.length === sessionState.log.length;
        setSession({ log: sameLog ? sessionState.log : room.log, mySeats, connected: true, presence });
        sentSeen = serverSeen;
        wantSeen = Math.min(Math.max(wantSeen, serverSeen), room.log.length);
      }
    }
    setRoom({ status: "open", room, seat, error: null });
    notify();
    scheduleSeen();
  };

  const receiveAppended = (gameNumber: number, entries: LogEntry[]) => {
    const room = roomState.room;
    if (!room || room.phase !== "playing" || gameNumber !== sessionState.gameNumber) {
      resync();
      return;
    }
    const length = sessionState.log.length;
    const fresh = entries.filter((entry) => entry.seq >= length);
    if (fresh.length === 0) return; // already have these
    const contiguous = fresh.every((entry, i) => entry.seq === length + i);
    if (!contiguous) {
      resync();
      return;
    }
    const log = [...sessionState.log, ...fresh];
    setSession({ log });
    setRoom({ room: { ...room, log } });
    notify();
  };

  const receivePresence = (connected: boolean[]) => {
    const room = roomState.room;
    if (!room) return;
    const seats = room.seats.map((seat, i) => ({ ...seat, connected: connected[i] === true }));
    setRoom({ room: { ...room, seats } });
    setSession({ presence: seats.map((s) => s.connected) });
    notify();
  };

  function receive(message: ServerMessage): void {
    switch (message.type) {
      case "room":
        receiveRoom(message.seat, message.room);
        break;
      case "appended":
        receiveAppended(message.gameNumber, message.entries);
        break;
      case "presence":
        receivePresence(message.connected);
        break;
      case "refused":
        finish(message.reason);
        break;
    }
  }

  // --- wake ------------------------------------------------------------------------------------

  const onWake = (event: WakeEvent) => {
    if (closed) return;
    if (event === "hidden") {
      hiddenAt ??= env.now();
      flushSeen();
      return;
    }
    const hiddenFor = hiddenAt === null ? 0 : env.now() - hiddenAt;
    if (event === "visible") hiddenAt = null;
    if (!isOpen()) {
      // Don't sit out the backoff: the player is looking at the screen (or the network is back).
      if (!socket) {
        attempt = 0;
        connect();
      }
      return;
    }
    if (hiddenFor > STALE_AFTER_HIDDEN_MS) resync();
  };

  function socketBase(): { protocol: string; host: string } {
    return typeof location === "undefined" ? { protocol: "http:", host: "localhost" } : location;
  }

  return {
    kind: "online",
    code,
    getState: () => sessionState,
    getRoom: () => roomState,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open() {
      if (opened || closed) return;
      opened = true;
      stopWake = env.onWake(onWake);
      // Deferred, so mounting twice in React StrictMode doesn't open and drop a real socket.
      retryTimer = env.setTimeout(connect, 0);
    },
    close() {
      if (closed) return;
      flushSeen();
      finish(null);
    },
    sendIntent(intent) {
      if (roomState.room?.phase !== "playing") return;
      send({ type: "intent", seq: sessionState.log.length, intent });
    },
    markSeen(seq) {
      const next = Math.min(Math.floor(seq), sessionState.log.length);
      if (!(next > wantSeen)) return;
      wantSeen = next;
      scheduleSeen();
    },
    configure(rules) {
      send({ type: "configure", rules });
    },
    start() {
      send({ type: "start" });
    },
    rematch() {
      if (roomState.room?.phase !== "playing") return;
      send({ type: "rematch", gameNumber: sessionState.gameNumber });
    },
    cancel() {
      return env.cancelInvite(code, deviceId);
    },
  };
}

export type { Intent };
