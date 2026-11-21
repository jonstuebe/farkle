import { describe, expect, test } from "vitest";
import type { DieValue } from "../game/scoring";
import { Presenter } from "../game/presenter";
import { FakeRoomServer } from "./fakeRoom";
import {
  CONNECT_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  SEEN_THROTTLE_MS,
  STALE_AFTER_HIDDEN_MS,
  createOnlineSession,
  parseServerMessage,
  reconnectDelay,
  roomSocketUrl,
  type OnlineEnv,
  type OnlineSession,
  type TimerHandle,
  type WakeEvent,
} from "./onlineSession";
import type { RoomView } from "./protocol";

const CODE = "ABCDEF";
const HOST = "device-host-0000000000";
const BO = "device-bo-00000000000000";
const CY = "device-cy-00000000000000";

/** A clock with timers that only move when the test says so. */
class FakeClock {
  time = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; run: () => void }>();
  setTimeout = (run: () => void, ms: number): TimerHandle => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), run });
    return id;
  };
  clearTimeout = (handle: TimerHandle): void => {
    this.timers.delete(handle as number);
  };
  get pending(): number {
    return this.timers.size;
  }
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].run();
    }
    this.time = end;
  }
}

/** Dice that come up in a fixed order, so games are predictable. */
const dice = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length] as DieValue;
};

function setup(randomDie?: () => DieValue) {
  const clock = new FakeClock();
  const server = new FakeRoomServer(CODE, randomDie);
  const wake = new Set<(event: WakeEvent) => void>();
  const cancelled: string[] = [];
  const env: Partial<OnlineEnv> = {
    createSocket: server.createSocket,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.time,
    random: () => 0.5,
    onWake(listener) {
      wake.add(listener);
      return () => wake.delete(listener);
    },
    cancelInvite: async (_code, device) => {
      cancelled.push(device);
      const ok = server.cancel(device);
      server.run();
      return ok;
    },
  };
  /** Let timers fire and the server deliver until both are quiet (without advancing far). */
  const settle = (ms = 0) => {
    server.run();
    clock.advance(ms);
    server.run();
    clock.advance(0);
    server.run();
  };
  const connect = (deviceId: string, name: string, intent: "host" | "join" = "join") => {
    const session = createOnlineSession({ code: CODE, deviceId, name, intent, env });
    session.open();
    settle();
    return session;
  };
  const emitWake = (event: WakeEvent) => {
    for (const listener of [...wake]) listener(event);
  };
  return { clock, server, env, settle, connect, emitWake, wake, cancelled };
}

/** Host + Bo seated and the game started. Dice: every throw is 1,1,1,2,3,4 style from `values`. */
function startedGame(randomDie: () => DieValue = dice(1, 5, 2, 3, 4, 6)) {
  const t = setup(randomDie);
  const host = t.connect(HOST, "Ada", "host");
  const bo = t.connect(BO, "Bo");
  host.start();
  t.settle();
  return { ...t, host, bo };
}

const playing = (session: OnlineSession): Extract<RoomView, { phase: "playing" }> => {
  const room = session.getRoom().room;
  if (room?.phase !== "playing") throw new Error("expected a game in progress");
  return room;
};

describe("connecting", () => {
  test("builds the socket URL from the page origin", () => {
    const params = { deviceId: "d e/v", name: "Ada & Bo", intent: "host" as const };
    expect(roomSocketUrl("ABCDEF", params, { protocol: "https:", host: "farkle.example" })).toBe(
      "wss://farkle.example/api/rooms/ABCDEF/socket?device=d+e%2Fv&name=Ada+%26+Bo&intent=host",
    );
    expect(roomSocketUrl("ABCDEF", params, { protocol: "http:", host: "localhost:5173" })).toMatch(/^ws:\/\/localhost:5173\//);
  });

  test("open() is deferred, so an immediate close() never creates a socket", () => {
    const t = setup();
    const session = createOnlineSession({ code: CODE, deviceId: HOST, name: "Ada", intent: "host", env: t.env });
    session.open();
    session.open();
    expect(t.server.sockets).toHaveLength(0);
    session.close();
    t.settle(1000);
    expect(t.server.sockets).toHaveLength(0);
    expect(session.getRoom().status).toBe("closed");
    expect(t.wake.size).toBe(0);
  });

  test("the host creates the room and lands in the lobby as seat 0", () => {
    const t = setup();
    const session = createOnlineSession({ code: CODE, deviceId: HOST, name: "Ada", intent: "host", env: t.env });
    expect(session.getRoom()).toEqual({ status: "connecting", room: null, seat: null, error: null });
    expect(session.getState().connected).toBe(false);
    let changes = 0;
    session.subscribe(() => changes++);
    session.open();
    t.settle();

    const { status, seat, room, error } = session.getRoom();
    expect({ status, seat, error }).toEqual({ status: "open", seat: 0, error: null });
    expect(room).toMatchObject({ phase: "lobby", code: CODE, seats: [{ name: "Ada", connected: true }] });
    expect(session.getState()).toMatchObject({ gameNumber: 0, mySeats: [0], connected: true, presence: [true], log: [] });
    expect(changes).toBe(1);
    expect(t.server.sockets[0]!.url.searchParams.get("intent")).toBe("host");
    expect(t.server.sockets[0]!.url.searchParams.get("name")).toBe("Ada");
  });

  test("guests join and everyone sees the seats and presence", () => {
    const t = setup();
    const host = t.connect(HOST, "Ada", "host");
    const bo = t.connect(BO, "Bo");
    expect(bo.getRoom().seat).toBe(1);
    expect(host.getRoom().room?.seats).toEqual([
      { name: "Ada", connected: true },
      { name: "Bo", connected: true },
    ]);
    bo.close();
    t.settle();
    expect(host.getRoom().room?.seats[1]).toEqual({ name: "Bo", connected: false });
    expect(host.getState().presence).toEqual([true, false]);
  });

  test.each(["missing", "full", "started"] as const)("refused: %s is final", (reason) => {
    const t = setup();
    if (reason !== "missing") {
      const host = t.connect(HOST, "Ada", "host");
      const guests = reason === "full" ? 7 : 1;
      for (let i = 0; i < guests; i++) t.connect(`device-guest-${i}-0000000000`, `G${i}`);
      if (reason === "started") {
        host.start();
        t.settle();
      }
    }
    const late = t.connect("device-late-000000000000", "Late");
    expect(late.getRoom()).toMatchObject({ status: "closed", error: reason, room: null });
    const socketsBefore = t.server.sockets.length;
    t.settle(60_000);
    t.emitWake("visible");
    t.settle(60_000);
    expect(t.server.sockets).toHaveLength(socketsBefore);
  });

  test("a join never creates a room, and a reconnect never re-creates one that expired", () => {
    const t = setup();
    const host = t.connect(HOST, "Ada", "host");
    // The network drops, and while the host is away the room expires.
    t.server.drop(t.server.sockets[0]!);
    t.server.room = null;
    t.settle(RECONNECT_MAX_MS * 2);
    expect(t.server.sockets.at(-1)!.url.searchParams.get("intent")).toBe("join");
    // The lobby it was in is gone: shown as called off, not as a typo in the code.
    expect(host.getRoom()).toMatchObject({ status: "closed", error: "cancelled" });
    expect(t.server.room).toBeNull();
  });

  test("server close codes: expired and cancelled are final", () => {
    const expired = setup();
    const a = expired.connect(HOST, "Ada", "host");
    expired.server.expire();
    expired.settle(60_000);
    expect(a.getRoom()).toMatchObject({ status: "closed", error: "expired" });
    expect(expired.server.sockets).toHaveLength(1);

    const t = setup();
    const host = t.connect(HOST, "Ada", "host");
    const bo = t.connect(BO, "Bo");
    return host.cancel().then((ok) => {
      expect(ok).toBe(true);
      expect(t.cancelled).toEqual([HOST]);
      expect(host.getRoom()).toMatchObject({ status: "closed", error: "cancelled" });
      expect(bo.getRoom()).toMatchObject({ status: "closed", error: "cancelled" });
      expect(bo.getState().connected).toBe(false);
    });
  });
});

describe("a room that goes away while open", () => {
  test("refused/missing in the lobby reads as cancelled; during a game as expired", () => {
    const t = setup();
    t.connect(HOST, "Ada", "host");
    const bo = t.connect(BO, "Bo");
    t.server.push(t.server.socketOf(BO)!, { type: "refused", reason: "missing" });
    t.settle();
    expect(bo.getRoom()).toMatchObject({ status: "closed", error: "cancelled" });
    expect(t.server.socketOf(BO)!.closedByClient).toBe(true);

    const game = startedGame();
    game.server.push(game.server.socketOf(BO)!, { type: "refused", reason: "missing" });
    game.settle(60_000);
    expect(game.bo.getRoom()).toMatchObject({ status: "closed", error: "expired" });
    expect(game.server.sockets.filter((s) => s.url.searchParams.get("device") === BO)).toHaveLength(1);
  });
});

describe("lobby", () => {
  test("the host configures rules and starts; guests can't", () => {
    const t = setup();
    const host = t.connect(HOST, "Ada", "host");
    host.start(); // one seat: refused
    t.settle();
    expect(host.getRoom().room?.phase).toBe("lobby");

    const bo = t.connect(BO, "Bo");
    bo.configure({ targetScore: 500 });
    bo.start();
    t.settle();
    expect(bo.getRoom().room).toMatchObject({ phase: "lobby", rules: { targetScore: 10_000 } });

    host.configure({ targetScore: 5000, entryThreshold: 500 });
    t.settle();
    expect(bo.getRoom().room).toMatchObject({ phase: "lobby", rules: { targetScore: 5000, entryThreshold: 500 } });
    expect(bo.getState().input.rules).toMatchObject({ targetScore: 5000 });

    host.start();
    t.settle();
    for (const session of [host, bo]) {
      expect(session.getRoom().room).toMatchObject({ phase: "playing", gameNumber: 1 });
      expect(session.getState()).toMatchObject({
        gameNumber: 1,
        input: { players: ["Ada", "Bo"], rules: { targetScore: 5000, entryThreshold: 500 } },
        log: [],
        seenFrom: 0,
        connected: true,
      });
    }
    expect(host.getState().mySeats).toEqual([0]);
    expect(bo.getState().mySeats).toEqual([1]);
  });
});

describe("leaving the lobby", () => {
  test("a guest's leave() sends `leave` and closes for good", () => {
    const t = setup();
    t.connect(HOST, "Ada", "host");
    const bo = t.connect(BO, "Bo");
    const socket = t.server.socketOf(BO)!;
    bo.leave();
    expect(socket.sent.at(-1)).toEqual({ type: "leave" });
    expect(socket.closedByClient).toBe(true);
    expect(bo.getRoom()).toMatchObject({ status: "closed", error: null });
    const sockets = t.server.sockets.length;
    t.settle(60_000);
    expect(t.server.sockets).toHaveLength(sockets);
    bo.leave(); // again: nothing
    expect(socket.sent.filter((m) => (m as { type: string }).type === "leave")).toHaveLength(1);
  });

  test("the host and players in a started game never send `leave`", () => {
    const t = setup();
    const host = t.connect(HOST, "Ada", "host");
    host.leave();
    expect(t.server.socketOf(HOST)!.sent).not.toContainEqual({ type: "leave" });
    expect(host.getRoom().status).toBe("closed");

    const game = startedGame();
    game.bo.leave();
    expect(game.server.socketOf(BO)!.sent).not.toContainEqual({ type: "leave" });
  });

  test("the seat follows every room message: someone ahead leaving moves this device up", () => {
    const t = setup();
    const host = t.connect(HOST, "Ada", "host");
    t.connect(BO, "Bo");
    const cy = t.connect(CY, "Cy");
    expect(cy.getRoom().seat).toBe(2);
    expect(cy.getState().mySeats).toEqual([2]);

    // Bo leaves: the server sends everyone the new seating, with Cy now in seat 1.
    const seats = [
      { name: "Ada", connected: true },
      { name: "Cy", connected: true },
    ];
    const room = { phase: "lobby" as const, code: CODE, seats, rules: host.getState().input.rules! as never };
    t.server.push(t.server.socketOf(CY)!, { type: "room", seat: 1, room });
    t.server.push(t.server.socketOf(HOST)!, { type: "room", seat: 0, room });
    t.settle();
    expect(cy.getRoom()).toMatchObject({ status: "open", seat: 1 });
    expect(cy.getState()).toMatchObject({ mySeats: [1], presence: [true, true], input: { players: ["Ada", "Cy"] } });
    expect(host.getRoom().seat).toBe(0);
    const mySeats = host.getState().mySeats;
    t.server.push(t.server.socketOf(HOST)!, { type: "room", seat: 0, room });
    t.settle();
    expect(host.getState().mySeats).toBe(mySeats); // unchanged seat keeps its identity
  });
});

describe("playing", () => {
  test("sendIntent carries the log length; entries arrive for everyone", () => {
    const { host, bo, server, settle } = startedGame();
    host.sendIntent({ type: "roll" });
    expect(server.socketOf(HOST)!.sent.at(-1)).toEqual({ type: "intent", seq: 0, intent: { type: "roll" } });
    settle();
    for (const session of [host, bo]) {
      expect(session.getState().log.map((e) => e.event.type)).toEqual(["roll", "rolled"]);
      expect(playing(session).log).toBe(session.getState().log);
    }
    host.sendIntent({ type: "toggleDie", index: 0 });
    expect(server.socketOf(HOST)!.sent.at(-1)).toMatchObject({ seq: 2 });
    settle();
    expect(bo.getState().log).toHaveLength(3);
  });

  test("state objects only change identity when something changed", () => {
    const { host, bo, settle } = startedGame();
    const before = host.getState();
    expect(host.getState()).toBe(before);
    bo.sendIntent({ type: "roll" }); // not Bo's turn: rejected, the server just re-sends the room
    settle();
    expect(host.getState()).toBe(before);
    expect(bo.getState().log).toHaveLength(0);
    expect(bo.getRoom().status).toBe("open");
  });

  test("a stale seq (double tap) is rejected by the server and the room comes back", () => {
    const { host, server, settle } = startedGame();
    host.sendIntent({ type: "roll" });
    host.sendIntent({ type: "roll" }); // sent before the first answer arrived: same seq 0
    settle();
    expect(host.getState().log.map((e) => e.event.type)).toEqual(["roll", "rolled"]);
    expect(server.room).toMatchObject({ log: { length: 2 } });
  });

  test("nothing is sent while disconnected", () => {
    const { host, server, settle } = startedGame();
    const socket = server.socketOf(HOST)!;
    server.offline = true;
    server.drop(socket);
    settle();
    expect(host.getState().connected).toBe(false);
    expect(() => host.sendIntent({ type: "roll" })).not.toThrow();
    host.start();
    host.rematch();
    expect(socket.sent.filter((m) => (m as { type: string }).type !== "seen")).toHaveLength(1); // just the earlier `start`
  });

  test("duplicate appended entries are ignored", () => {
    const { host, bo, server, settle } = startedGame();
    host.sendIntent({ type: "roll" });
    settle();
    const log = bo.getState().log;
    server.push(server.socketOf(BO)!, { type: "appended", gameNumber: 1, entries: [...log] });
    settle();
    expect(bo.getState().log).toBe(log);
    expect(server.sockets.filter((s) => s.url.searchParams.get("device") === BO)).toHaveLength(1);
  });

  test("a gap in appended entries resyncs by reconnecting", () => {
    const { host, bo, server, settle } = startedGame();
    host.sendIntent({ type: "roll" });
    settle();
    host.sendIntent({ type: "toggleDie", index: 0 });
    settle();
    const real = server.room!;
    if (real.phase !== "playing") throw new Error("not playing");
    // Bo's socket misses a message: pretend its log is behind, then deliver a later entry.
    const first = server.socketOf(BO)!;
    server.push(first, { type: "appended", gameNumber: 1, entries: [{ seq: 7, seat: 0, event: { type: "bank" } }] });
    let sawDisconnected = false;
    bo.subscribe(() => {
      if (!bo.getState().connected) sawDisconnected = true;
    });
    settle();
    const second = server.socketOf(BO)!;
    expect(second).not.toBe(first);
    expect(first.closedByClient).toBe(true);
    expect(sawDisconnected).toBe(true);
    expect(bo.getRoom().status).toBe("open");
    expect(bo.getState().log).toEqual(real.log);
    expect(bo.getState().connected).toBe(true);
  });

  test("appended for another game number resyncs", () => {
    const { bo, server, settle } = startedGame();
    const first = server.socketOf(BO)!;
    server.push(first, { type: "appended", gameNumber: 2, entries: [{ seq: 0, seat: 0, event: { type: "roll" } }] });
    settle();
    expect(server.socketOf(BO)).not.toBe(first);
    expect(bo.getState()).toMatchObject({ gameNumber: 1, log: [], connected: true });
  });

  test("garbage frames are ignored", () => {
    const { bo, server, settle } = startedGame();
    const socket = server.socketOf(BO)!;
    const before = bo.getState();
    for (const frame of ["", "{", "null", "[]", '{"type":"nope"}', '{"type":"room"}', '{"type":"appended","gameNumber":1}']) {
      server.push(socket, frame);
    }
    settle();
    expect(bo.getState()).toBe(before);
    expect(parseServerMessage(42)).toBeNull();
    expect(parseServerMessage('{"type":"refused","reason":"because"}')).toBeNull();
    expect(parseServerMessage('{"type":"presence","connected":[true]}')).toEqual({ type: "presence", connected: [true] });
  });
});

describe("seen", () => {
  test("markSeen is throttled, monotonic, and capped at the log length", () => {
    const { host, bo, server, settle, clock } = startedGame();
    host.sendIntent({ type: "roll" });
    settle();
    host.sendIntent({ type: "toggleDie", index: 0 });
    settle();
    const socket = server.socketOf(BO)!;
    const seen = () => socket.sent.filter((m) => (m as { type: string; seq: number }).type === "seen" && (m as { seq: number }).seq > 0);

    bo.markSeen(1);
    expect(seen()).toEqual([{ type: "seen", seq: 1 }]); // first one goes straight out
    bo.markSeen(2);
    bo.markSeen(3);
    bo.markSeen(2); // backwards: ignored
    bo.markSeen(99); // beyond the log: capped
    expect(seen()).toHaveLength(1);
    clock.advance(SEEN_THROTTLE_MS - 1);
    expect(seen()).toHaveLength(1);
    clock.advance(1);
    expect(seen()).toEqual([
      { type: "seen", seq: 1 },
      { type: "seen", seq: 3 },
    ]);
    bo.markSeen(3);
    clock.advance(SEEN_THROTTLE_MS * 3);
    expect(seen()).toHaveLength(2);
    expect(server.room).toMatchObject({ seen: [0, 3] });
  });

  test("the latest position is flushed when the page is hidden and on close", () => {
    const { host, bo, server, settle, emitWake } = startedGame();
    host.sendIntent({ type: "roll" });
    settle();
    host.sendIntent({ type: "toggleDie", index: 0 });
    settle();
    bo.markSeen(1);
    bo.markSeen(2);
    emitWake("hidden");
    expect(server.room).toMatchObject({ seen: [0, 2] });
    bo.markSeen(3);
    bo.close();
    expect(server.room).toMatchObject({ seen: [0, 3] });
  });

  test("seenFrom comes from the server when the game is opened, on any device", () => {
    const { host, bo, server, settle, connect } = startedGame();
    host.sendIntent({ type: "roll" });
    settle();
    bo.markSeen(2);
    bo.close();
    settle();
    host.sendIntent({ type: "toggleDie", index: 0 });
    settle();
    host.sendIntent({ type: "bank" });
    settle();

    const again = connect(BO, "Bo");
    expect(again.getState()).toMatchObject({ gameNumber: 1, seenFrom: 2, mySeats: [1] });
    expect(again.getState().log).toHaveLength(4);
    expect(server.summary(BO)).toMatchObject({ status: "yourTurn", unseen: 2 });
  });

  test("seenFrom stays put across reconnects, and unsent progress is sent afterwards", () => {
    const { host, bo, server, settle } = startedGame();
    host.sendIntent({ type: "roll" });
    settle();
    expect(bo.getState().seenFrom).toBe(0);
    const first = server.socketOf(BO)!;
    server.drop(first);
    server.run();
    bo.markSeen(2); // watched while offline
    settle(RECONNECT_MAX_MS);
    expect(bo.getRoom().status).toBe("open");
    expect(bo.getState().seenFrom).toBe(0);
    expect(server.socketOf(BO)!.sent).toEqual([
      { type: "seen", seq: 0 }, // the hello every socket sends on open
      { type: "seen", seq: 2 },
    ]);
    expect(server.room).toMatchObject({ seen: [0, 2] });
  });
});

describe("reconnecting", () => {
  test("backoff grows, is capped, and has jitter", () => {
    expect(reconnectDelay(0, 0.5)).toBe(500);
    expect(reconnectDelay(1, 0.5)).toBe(1000);
    expect(reconnectDelay(3, 0.5)).toBe(4000);
    expect(reconnectDelay(50, 0.5)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(0, 0)).toBeLessThan(reconnectDelay(0, 1));
    expect(reconnectDelay(50, 1)).toBeLessThanOrEqual(RECONNECT_MAX_MS * 1.25);
  });

  test("connected goes false while the socket is down and true again after", () => {
    const { host, bo, server, settle, clock } = startedGame();
    const first = server.socketOf(BO)!;
    const history: boolean[] = [];
    bo.subscribe(() => history.push(bo.getState().connected));
    server.offline = true;
    server.drop(first);
    server.run();
    expect(bo.getRoom()).toMatchObject({ status: "reconnecting", error: null });
    expect(bo.getRoom().room).not.toBeNull();
    expect(bo.getState().connected).toBe(false);
    expect(host.getState().presence).toEqual([true, false]);

    // Attempts back off: 500ms, then 1s after the 8s timeout, ...
    clock.advance(499);
    expect(server.sockets.filter((s) => s.url.searchParams.get("device") === BO)).toHaveLength(1);
    clock.advance(1);
    expect(server.sockets.filter((s) => s.url.searchParams.get("device") === BO)).toHaveLength(2);
    clock.advance(CONNECT_TIMEOUT_MS + 999);
    expect(server.sockets.filter((s) => s.url.searchParams.get("device") === BO)).toHaveLength(2);
    clock.advance(1);
    expect(server.sockets.filter((s) => s.url.searchParams.get("device") === BO)).toHaveLength(3);

    // Moves made meanwhile are there after reconnecting.
    host.sendIntent({ type: "roll" });
    server.offline = false;
    settle(CONNECT_TIMEOUT_MS + RECONNECT_MAX_MS * 2);
    expect(bo.getRoom().status).toBe("open");
    expect(bo.getState()).toMatchObject({ connected: true, presence: [true, true] });
    expect(bo.getState().log).toHaveLength(2);
    expect(history[0]).toBe(false);
    expect(history.at(-1)).toBe(true);
  });

  test("a first connection that never opens keeps trying (status stays connecting)", () => {
    const t = setup();
    t.server.offline = true;
    const session = t.connect(HOST, "Ada", "host");
    t.settle(CONNECT_TIMEOUT_MS + 5000);
    expect(session.getRoom()).toMatchObject({ status: "connecting", room: null, error: null });
    expect(t.server.sockets.length).toBeGreaterThan(1);
    expect(t.server.sockets.every((s) => s.url.searchParams.get("intent") === "host")).toBe(true);
    t.server.offline = false;
    t.settle(CONNECT_TIMEOUT_MS + RECONNECT_MAX_MS * 2);
    expect(session.getRoom()).toMatchObject({ status: "open", seat: 0 });
  });

  test("coming back to the tab retries at once instead of waiting out the backoff", () => {
    const { bo, server, settle, clock, emitWake } = startedGame();
    server.offline = true;
    server.drop(server.socketOf(BO)!);
    server.run();
    clock.advance(CONNECT_TIMEOUT_MS * 6); // several failed attempts: the backoff is long now
    expect(bo.getState().connected).toBe(false);
    clock.advance(CONNECT_TIMEOUT_MS); // let any attempt in flight time out
    server.offline = false;
    const before = server.sockets.length;
    emitWake("online");
    emitWake("visible");
    expect(server.sockets.length).toBeLessThanOrEqual(before + 1);
    settle();
    expect(bo.getState().connected).toBe(true);
  });

  test("after a long time hidden the socket is replaced even if it looks open", () => {
    const { host, bo, server, settle, clock, emitWake } = startedGame();
    const first = server.socketOf(BO)!;
    emitWake("hidden");
    clock.advance(STALE_AFTER_HIDDEN_MS - 1);
    emitWake("visible");
    settle();
    expect(server.socketOf(BO)).toBe(first);

    emitWake("hidden");
    emitWake("hidden"); // pagehide + visibilitychange both fire
    clock.advance(STALE_AFTER_HIDDEN_MS + 1);
    host.sendIntent({ type: "roll" });
    emitWake("visible");
    settle();
    expect(server.socketOf(BO)).not.toBe(first);
    expect(first.closedByClient).toBe(true);
    expect(bo.getState()).toMatchObject({ connected: true, seenFrom: 0 });
    expect(bo.getState().log).toHaveLength(2);
  });

  test("close() stops everything", () => {
    const { bo, server, settle, clock, wake, emitWake } = startedGame();
    const wakeBefore = wake.size;
    let calls = 0;
    bo.subscribe(() => calls++);
    bo.close();
    expect(calls).toBe(1);
    expect(wake.size).toBe(wakeBefore - 1);
    expect(bo.getRoom()).toMatchObject({ status: "closed", error: null });
    const sockets = server.sockets.length;
    emitWake("visible");
    settle(120_000);
    expect(server.sockets).toHaveLength(sockets);
    expect(clock.pending).toBe(0);
    bo.close();
    bo.open();
    expect(calls).toBe(1);
  });
});

describe("rematch", () => {
  /** Ada reaches the 500 target with three 5s and Bo farkles his last turn. */
  function finishedGame() {
    const t = setup(dice(5, 5, 5, 2, 3, 4, /* Bo: */ 2, 3, 4, 6, 6, 2));
    const host = t.connect(HOST, "Ada", "host");
    const bo = t.connect(BO, "Bo");
    host.configure({ targetScore: 500 });
    t.settle();
    host.start();
    t.settle();
    const act = (session: OnlineSession, ...intents: Parameters<OnlineSession["sendIntent"]>[0][]) => {
      for (const intent of intents) {
        session.sendIntent(intent);
        t.settle();
      }
    };
    act(host, { type: "roll" }, { type: "toggleDie", index: 0 }, { type: "toggleDie", index: 1 }, { type: "toggleDie", index: 2 }, { type: "bank" });
    act(bo, { type: "roll" }, { type: "passTurn" });
    return { ...t, host, bo };
  }

  test("starts game 2 with an empty log for everyone", () => {
    const { host, bo, server, settle } = finishedGame();
    expect(server.summary(BO)).toMatchObject({ status: "over", winners: [0], scores: [500, 0] });
    const finishedLog = host.getState().log;
    expect(finishedLog.length).toBeGreaterThan(0);
    host.markSeen(finishedLog.length);

    bo.rematch();
    expect(server.socketOf(BO)!.sent.at(-1)).toEqual({ type: "rematch", gameNumber: 1 });
    settle();
    for (const session of [host, bo]) {
      expect(session.getState()).toMatchObject({ gameNumber: 2, log: [], seenFrom: 0, connected: true });
      expect(session.getState().input.players).toEqual(["Ada", "Bo"]);
    }
    // A second tap from the other player is for the old game: nothing happens.
    host.rematch();
    settle();
    expect(server.room).toMatchObject({ gameNumber: 2 });

    // Seen tracking restarts with the new game.
    host.sendIntent({ type: "roll" });
    settle();
    bo.markSeen(2);
    expect(server.room).toMatchObject({ seen: [0, 2] });
  });

  test("rematch is refused while the game is still going", () => {
    const { host, server, settle } = startedGame();
    host.rematch();
    settle();
    expect(server.room).toMatchObject({ gameNumber: 1 });
    expect(host.getState().gameNumber).toBe(1);
  });
});

describe("with the Presenter", () => {
  test("a returning player replays what they missed and the server learns they watched it", () => {
    const { host, bo, server, settle, connect, clock } = startedGame();
    bo.close();
    settle();
    host.sendIntent({ type: "roll" });
    settle();
    host.sendIntent({ type: "toggleDie", index: 0 });
    settle();
    host.sendIntent({ type: "bank" });
    settle();

    const again = connect(BO, "Bo");
    const presenter = new Presenter(again, { pacing: 0 });
    expect(presenter.getView()).toMatchObject({ replaying: true, total: 4 });
    const pending = presenter.getView().pendingThrow;
    expect(pending).not.toBeNull();
    presenter.throwSettled(pending!.seq);
    expect(presenter.getView()).toMatchObject({ replaying: false, fed: 4 });
    expect(presenter.canAct()).toBe(true);
    clock.advance(SEEN_THROTTLE_MS);
    expect(server.room).toMatchObject({ seen: [0, 4] });
    expect(server.summary(BO)).toMatchObject({ status: "yourTurn", unseen: 0 });

    // While reconnecting the player can't act.
    server.offline = true;
    server.drop(server.socketOf(BO)!);
    server.run();
    expect(presenter.canAct()).toBe(false);
    presenter.stop();
  });

  test("three players: a third seat watches live", () => {
    const t = setup(dice(1, 5, 2, 3, 4, 6));
    const host = t.connect(HOST, "Ada", "host");
    t.connect(BO, "Bo");
    const cy = t.connect(CY, "Cy");
    host.start();
    t.settle();
    expect(cy.getState()).toMatchObject({ mySeats: [2], input: { players: ["Ada", "Bo", "Cy"] } });
    host.sendIntent({ type: "roll" });
    t.settle();
    expect(cy.getState().log).toHaveLength(2);
  });
});
