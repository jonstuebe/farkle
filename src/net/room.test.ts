import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "../game/machine";
import type { DieValue } from "../game/scoring";
import type { Intent } from "../game/log";
import {
  FINISHED_GAME_LIFETIME_MS,
  IDLE_GAME_LIFETIME_MS,
  LOBBY_LIFETIME_MS,
  MAX_SEATS,
  REACTIONS,
  REACTION_COOLDOWN_MS,
  type ClientMessage,
} from "./protocol";
import {
  applyMessage,
  cancellationOf,
  configure,
  isDeviceId,
  isGameOver,
  isReactionAllowed,
  isRoomIntent,
  lifetimeOf,
  parseClientMessage,
  parsePlayerName,
  presenceOf,
  seatAfterLeave,
  seat,
  seatOfDevice,
  snapshotOf,
  start,
  summaryOf,
  viewOf,
  type PlayingRoom,
  type Room,
} from "./room";

const device = (n: number) => `device-${String(n).padStart(12, "0")}`;

/** Dice that come up in the given order, then repeat. */
const dice = (...values: DieValue[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

function lobby(seats: number, names: (string | null)[] = []): Room {
  let room: Room | null = null;
  for (let i = 0; i < seats; i++) {
    const seating = seat(room, device(i), i === 0 ? "host" : "join", names[i] ?? null);
    if (!seating.ok) throw new Error(seating.reason);
    room = seating.room;
  }
  return room!;
}

function playing(seats = 2, names: (string | null)[] = []): PlayingRoom {
  const room = start(lobby(seats, names), 0);
  if (room.phase !== "playing") throw new Error("did not start");
  return room;
}

/** Sends an intent with the right seq and returns the room after it (throws if it's refused). */
function move(room: PlayingRoom, bySeat: number, intent: Intent, randomDie = dice(1)): PlayingRoom {
  const outcome = applyMessage(room, bySeat, { type: "intent", seq: room.log.length, intent }, randomDie);
  if (outcome.kind !== "appended") throw new Error(`${intent.type} by seat ${bySeat}: ${outcome.kind}`);
  return outcome.room;
}

/** One turn: roll six 1s-and-5s-free dice that score `1,1,1` (1000) and bank them. */
function bankThousand(room: PlayingRoom, bySeat: number): PlayingRoom {
  let next = move(room, bySeat, { type: "roll" }, dice(1, 1, 1, 2, 3, 4));
  for (const index of [0, 1, 2]) next = move(next, bySeat, { type: "toggleDie", index });
  return move(next, bySeat, { type: "bank" });
}

/** A two-player game to 1000 that seat 0 has won. */
function finished(): PlayingRoom {
  const room = start(configure(lobby(2, ["Ada", "Bo"]), 0, { targetScore: 1000 }), 0) as PlayingRoom;
  let next = bankThousand(room, 0);
  // Seat 1's last turn: a farkle.
  next = move(next, 1, { type: "roll" }, dice(2, 3, 4, 6, 2, 3));
  return move(next, 1, { type: "passTurn" });
}

describe("seat", () => {
  it("opens a room for a host, who gets seat 0", () => {
    const seating = seat(null, device(0), "host", "Ada");
    expect(seating).toEqual({
      ok: true,
      seat: 0,
      room: { phase: "lobby", seats: [{ device: device(0), name: "Ada" }], rules: DEFAULT_RULES },
    });
  });

  it("refuses a join when there is no room", () => {
    expect(seat(null, device(1), "join", "Bo")).toEqual({ ok: false, reason: "missing" });
  });

  it("seats guests in the order they arrive, with a stand-in name when they sent none", () => {
    const room = lobby(3, ["Ada", null, "Cy"]);
    expect(room.seats.map((s) => s.name)).toEqual(["Ada", "Player 2", "Cy"]);
    expect(seatOfDevice(room, device(2))).toBe(2);
    expect(seatOfDevice(room, device(9))).toBeNull();
  });

  it("gives a returning device its own seat and the same room object", () => {
    const room = lobby(3);
    const seating = seat(room, device(1), "join", null);
    expect(seating).toEqual({ ok: true, room, seat: 1 });
    if (seating.ok) expect(seating.room).toBe(room);
  });

  it("keeps the room object when the name is unchanged, and updates it when it changed", () => {
    const room = lobby(2, ["Ada", "Bo"]);
    const same = seat(room, device(1), "join", "Bo");
    expect(same.ok && same.room).toBe(room);
    const renamed = seat(room, device(1), "join", "Bobby");
    expect(renamed.ok && renamed.room.seats.map((s) => s.name)).toEqual(["Ada", "Bobby"]);
    expect(renamed.ok && renamed.seat).toBe(1);
  });

  it("fills up at MAX_SEATS, but seated devices still get in", () => {
    const room = lobby(MAX_SEATS);
    expect(room.seats).toHaveLength(MAX_SEATS);
    expect(seat(room, device(MAX_SEATS), "join", "Late")).toEqual({ ok: false, reason: "full" });
    expect(seat(room, device(3), "join", null)).toMatchObject({ ok: true, seat: 3 });
  });

  it("refuses new devices once the game has started, and keeps seats for the players", () => {
    const room = playing(2);
    expect(seat(room, device(5), "join", "Late")).toEqual({ ok: false, reason: "started" });
    expect(seat(room, device(5), "host", "Late")).toEqual({ ok: false, reason: "started" });
    expect(seat(room, device(1), "join", null)).toEqual({ ok: true, room, seat: 1 });
  });

  it("renames a seat mid-game without touching the game's own player names", () => {
    const room = playing(2, ["Ada", "Bo"]);
    const seating = seat(room, device(1), "join", "Bobby");
    if (!seating.ok || seating.room.phase !== "playing") throw new Error("expected a seat");
    expect(seating.room.seats[1]!.name).toBe("Bobby");
    expect(seating.room.input.players).toEqual(["Ada", "Bo"]);
  });

  it("treats a host intent on someone else's lobby as a join", () => {
    expect(seat(lobby(1), device(4), "host", "Dee")).toMatchObject({ ok: true, seat: 1 });
  });
});

describe("configure", () => {
  it("lets the host change the target and the entry threshold", () => {
    const room = configure(lobby(2), 0, { targetScore: 5000, entryThreshold: 500 });
    expect(room.phase === "lobby" && room.rules).toEqual({ ...DEFAULT_RULES, targetScore: 5000, entryThreshold: 500 });
  });

  it("changes only what was sent", () => {
    const room = configure(configure(lobby(2), 0, { targetScore: 5000 }), 0, { entryThreshold: 500 });
    expect(room.phase === "lobby" && room.rules.targetScore).toBe(5000);
  });

  it("returns the same room for a guest, after the start, or for a threshold above the target", () => {
    const room = lobby(2);
    expect(configure(room, 1, { targetScore: 5000 })).toBe(room);
    expect(configure(room, 0, { targetScore: 1000, entryThreshold: 2000 })).toBe(room);
    expect(configure(room, 0, { targetScore: DEFAULT_RULES.targetScore })).toBe(room);
    const game = playing(2);
    expect(configure(game, 0, { targetScore: 5000 })).toBe(game);
  });
});

describe("start", () => {
  it("deals game 1 with the seat names, the lobby's rules, an empty log, and nothing seen", () => {
    const room = start(configure(lobby(3, ["Ada", "Bo", "Cy"]), 0, { targetScore: 5000 }), 0);
    expect(room).toMatchObject({
      phase: "playing",
      gameNumber: 1,
      input: { players: ["Ada", "Bo", "Cy"], rules: { ...DEFAULT_RULES, targetScore: 5000 } },
      log: [],
      seen: [0, 0, 0],
    });
  });

  it("needs the host, two seats, and a lobby", () => {
    const alone = lobby(1);
    expect(start(alone, 0)).toBe(alone);
    const two = lobby(2);
    expect(start(two, 1)).toBe(two);
    const game = playing(2);
    expect(start(game, 0)).toBe(game);
  });
});

describe("applyMessage: lobby", () => {
  it("broadcasts the room after configure and start", () => {
    const room = lobby(2);
    const configured = applyMessage(room, 0, { type: "configure", rules: { targetScore: 5000 } });
    expect(configured).toMatchObject({ kind: "room", room: { rules: { targetScore: 5000 } } });
    expect(applyMessage(room, 0, { type: "start" })).toMatchObject({ kind: "room", room: { phase: "playing" } });
  });

  it("rejects a guest's configure and start, and a start with one seat", () => {
    const room = lobby(2);
    expect(applyMessage(room, 1, { type: "configure", rules: { targetScore: 5000 } })).toEqual({ kind: "rejected" });
    expect(applyMessage(room, 1, { type: "start" })).toEqual({ kind: "rejected" });
    expect(applyMessage(lobby(1), 0, { type: "start" })).toEqual({ kind: "rejected" });
  });

  it("ignores a configure that changes nothing, and rejects one that can't be applied", () => {
    const room = lobby(2);
    expect(applyMessage(room, 0, { type: "configure", rules: {} })).toEqual({ kind: "ignored" });
    expect(applyMessage(room, 0, { type: "configure", rules: { targetScore: 10_000 } })).toEqual({ kind: "ignored" });
    expect(applyMessage(room, 0, { type: "configure", rules: { targetScore: 1000, entryThreshold: 5000 } })).toEqual({
      kind: "rejected",
    });
  });

  it("rejects game messages in the lobby and ignores seen", () => {
    const room = lobby(2);
    expect(applyMessage(room, 0, { type: "intent", seq: 0, intent: { type: "roll" } })).toEqual({ kind: "rejected" });
    expect(applyMessage(room, 0, { type: "rematch", gameNumber: 1 })).toEqual({ kind: "rejected" });
    expect(applyMessage(room, 0, { type: "seen", seq: 3 })).toEqual({ kind: "ignored" });
  });

  it("ignores a seat that doesn't exist", () => {
    expect(applyMessage(lobby(2), 5, { type: "start" })).toEqual({ kind: "ignored" });
  });
});

describe("applyMessage: leave", () => {
  it("takes a guest's seat away and moves later seats up", () => {
    const room = lobby(4, ["Ada", "Bo", "Cy", "Dee"]);
    const outcome = applyMessage(room, 1, { type: "leave" });
    expect(outcome).toMatchObject({ kind: "left", seat: 1, room: { phase: "lobby" } });
    if (outcome.kind !== "left") return;
    expect(outcome.room.seats.map((s) => s.name)).toEqual(["Ada", "Cy", "Dee"]);
    expect(seatOfDevice(outcome.room, device(1))).toBeNull();
    expect(seatOfDevice(outcome.room, device(3))).toBe(2);
    expect(outcome.room.rules).toBe(room.phase === "lobby" && room.rules);
    // The original room is untouched.
    expect(room.seats).toHaveLength(4);
  });

  it("lets the last guest leave, and the device that left join again at the end", () => {
    const outcome = applyMessage(lobby(3, ["Ada", "Bo", "Cy"]), 1, { type: "leave" });
    if (outcome.kind !== "left") throw new Error(outcome.kind);
    const back = seat(outcome.room, device(1), "join", "Bo");
    expect(back.ok && back.seat).toBe(2);
    expect(back.ok && back.room.seats.map((s) => s.name)).toEqual(["Ada", "Cy", "Bo"]);
  });

  it("frees a seat in a full lobby", () => {
    const outcome = applyMessage(lobby(MAX_SEATS), 7, { type: "leave" });
    if (outcome.kind !== "left") throw new Error(outcome.kind);
    expect(seat(outcome.room, device(20), "join", "New")).toMatchObject({ ok: true, seat: 7 });
  });

  it("starts a game with the seats that stayed", () => {
    const outcome = applyMessage(lobby(3, ["Ada", "Bo", "Cy"]), 1, { type: "leave" });
    if (outcome.kind !== "left") throw new Error(outcome.kind);
    const game = start(outcome.room, 0) as PlayingRoom;
    expect(game.input.players).toEqual(["Ada", "Cy"]);
    expect(game.seen).toEqual([0, 0]);
    // Cy used to be seat 2 and now plays as seat 1.
    const next = bankThousand(game, 0);
    expect(applyMessage(next, 1, { type: "intent", seq: next.log.length, intent: { type: "roll" } }).kind).toBe("appended");
  });

  it("ignores the host, and anyone once the game has started", () => {
    expect(applyMessage(lobby(3), 0, { type: "leave" })).toEqual({ kind: "ignored" });
    expect(applyMessage(lobby(1), 0, { type: "leave" })).toEqual({ kind: "ignored" });
    expect(applyMessage(playing(3), 1, { type: "leave" })).toEqual({ kind: "ignored" });
    expect(applyMessage(finished(), 1, { type: "leave" })).toEqual({ kind: "ignored" });
  });

  it("renumbers sockets: the leaver loses its seat, later seats move up", () => {
    expect([0, 1, 2, 3].map((s) => seatAfterLeave(s, 1))).toEqual([0, null, 1, 2]);
    expect([0, 1, 2].map((s) => seatAfterLeave(s, 2))).toEqual([0, 1, null]);
  });
});

describe("applyMessage: intent", () => {
  it("appends a throw as two entries with the server's dice", () => {
    const room = playing(2);
    const outcome = applyMessage(room, 0, { type: "intent", seq: 0, intent: { type: "roll" } }, dice(1, 2, 3, 4, 5, 6));
    expect(outcome).toMatchObject({
      kind: "appended",
      entries: [
        { seq: 0, seat: 0, event: { type: "roll" } },
        { seq: 1, seat: 0, event: { type: "rolled", values: [1, 2, 3, 4, 5, 6] } },
      ],
    });
    if (outcome.kind !== "appended") return;
    expect(outcome.room.log).toHaveLength(2);
    // The original room is untouched.
    expect(room.log).toHaveLength(0);
  });

  it("uses a real die when none is passed in", () => {
    const outcome = applyMessage(playing(2), 0, { type: "intent", seq: 0, intent: { type: "roll" } });
    if (outcome.kind !== "appended") throw new Error(outcome.kind);
    const rolled = outcome.entries[1]!.event;
    expect(rolled.type === "rolled" && rolled.values.every((v) => v >= 1 && v <= 6)).toBe(true);
    expect(rolled.type === "rolled" && rolled.values).toHaveLength(6);
  });

  it("rejects a stale seq, a future seq, and a seat that isn't up", () => {
    const room = move(playing(2), 0, { type: "roll" });
    const roll: Intent = { type: "toggleDie", index: 0 };
    expect(applyMessage(room, 0, { type: "intent", seq: 0, intent: roll })).toEqual({ kind: "rejected" });
    expect(applyMessage(room, 0, { type: "intent", seq: 9, intent: roll })).toEqual({ kind: "rejected" });
    expect(applyMessage(room, 1, { type: "intent", seq: 2, intent: roll })).toEqual({ kind: "rejected" });
    expect(applyMessage(room, 0, { type: "intent", seq: 2, intent: roll }).kind).toBe("appended");
  });

  it("rejects a move the game doesn't allow right now", () => {
    const room = playing(2);
    expect(applyMessage(room, 0, { type: "intent", seq: 0, intent: { type: "bank" } })).toEqual({ kind: "rejected" });
  });

  it("passes the turn around the table", () => {
    let room = playing(3);
    room = bankThousand(room, 0);
    expect(snapshotOf(room).context.current).toBe(1);
    room = bankThousand(room, 1);
    room = bankThousand(room, 2);
    expect(snapshotOf(room).context.current).toBe(0);
    expect(snapshotOf(room).context.players.map((p) => p.score)).toEqual([1000, 1000, 1000]);
    expect(room.log.map((entry) => entry.seq)).toEqual(room.log.map((_, i) => i));
  });

  it("rejects every move once the game is over", () => {
    const room = finished();
    expect(isGameOver(room)).toBe(true);
    const roll: ClientMessage = { type: "intent", seq: room.log.length, intent: { type: "roll" } };
    expect(applyMessage(room, 0, roll)).toEqual({ kind: "rejected" });
  });

  it("gives the same game whether the snapshot is remembered or replayed from the log", () => {
    const room = bankThousand(playing(2), 0);
    const reloaded: PlayingRoom = JSON.parse(JSON.stringify(room));
    expect(snapshotOf(reloaded).context).toEqual(snapshotOf(room).context);
  });
});

describe("applyMessage: seen", () => {
  it("moves a seat's mark forward only, and never past the log", () => {
    const room = bankThousand(playing(2), 0);
    const length = room.log.length;
    const first = applyMessage(room, 1, { type: "seen", seq: 3 });
    expect(first).toMatchObject({ kind: "seen", room: { seen: [0, 3] } });
    if (first.kind !== "seen") return;
    expect(applyMessage(first.room, 1, { type: "seen", seq: 2 })).toEqual({ kind: "ignored" });
    expect(applyMessage(first.room, 1, { type: "seen", seq: 3 })).toEqual({ kind: "ignored" });
    expect(applyMessage(first.room, 1, { type: "seen", seq: 999 })).toMatchObject({
      kind: "seen",
      room: { seen: [0, length] },
    });
  });
});

describe("applyMessage: rematch", () => {
  it("deals the next game to the same seats, with their current names", () => {
    const over = finished();
    const renamed = seat(over, device(1), "join", "Bobby");
    if (!renamed.ok) throw new Error("expected a seat");
    const outcome = applyMessage(renamed.room, 1, { type: "rematch", gameNumber: 1 });
    expect(outcome).toMatchObject({
      kind: "room",
      room: {
        phase: "playing",
        gameNumber: 2,
        input: { players: ["Ada", "Bobby"], rules: { targetScore: 1000 } },
        log: [],
        seen: [0, 0],
      },
    });
  });

  it("rejects a rematch while the game is on, or for a game that's already been replaced", () => {
    expect(applyMessage(playing(2), 0, { type: "rematch", gameNumber: 1 })).toEqual({ kind: "rejected" });
    const outcome = applyMessage(finished(), 0, { type: "rematch", gameNumber: 1 });
    if (outcome.kind !== "room") throw new Error(outcome.kind);
    expect(applyMessage(outcome.room, 1, { type: "rematch", gameNumber: 1 })).toEqual({ kind: "rejected" });
    expect(applyMessage(finished(), 0, { type: "rematch", gameNumber: 2 })).toEqual({ kind: "rejected" });
  });
});

describe("applyMessage: react", () => {
  it("relays a seated player's reaction in the lobby, during a game and after it", () => {
    expect(applyMessage(lobby(2), 1, { type: "react", reaction: "fire" })).toEqual({
      kind: "reaction",
      seat: 1,
      reaction: "fire",
    });
    // Not only on your own turn.
    expect(applyMessage(playing(3), 2, { type: "react", reaction: "laugh" })).toEqual({
      kind: "reaction",
      seat: 2,
      reaction: "laugh",
    });
    expect(applyMessage(finished(), 0, { type: "react", reaction: "clap" })).toEqual({
      kind: "reaction",
      seat: 0,
      reaction: "clap",
    });
  });

  it("knows every reaction in the protocol", () => {
    for (const reaction of REACTIONS) {
      expect(applyMessage(lobby(1), 0, { type: "react", reaction }).kind).toBe("reaction");
    }
  });

  it("ignores a seat that isn't there and a name it doesn't know", () => {
    expect(applyMessage(lobby(2), 2, { type: "react", reaction: "fire" })).toEqual({ kind: "ignored" });
    const unknown = { type: "react", reaction: "poop" } as unknown as ClientMessage;
    expect(applyMessage(lobby(2), 0, unknown)).toEqual({ kind: "ignored" });
  });

  it("changes nothing in the room", () => {
    const room = playing(2);
    const frozen = JSON.stringify(room);
    applyMessage(room, 0, { type: "react", reaction: "skull" });
    expect(JSON.stringify(room)).toBe(frozen);
  });
});

describe("isReactionAllowed", () => {
  it("allows a socket's first reaction, then one per cooldown", () => {
    expect(isReactionAllowed(null, 5_000)).toBe(true);
    expect(isReactionAllowed(5_000, 5_000)).toBe(false);
    expect(isReactionAllowed(5_000, 5_000 + REACTION_COOLDOWN_MS - 1)).toBe(false);
    expect(isReactionAllowed(5_000, 5_000 + REACTION_COOLDOWN_MS)).toBe(true);
  });

  it("doesn't lock a socket out if the clock steps back", () => {
    expect(isReactionAllowed(5_000, 4_000)).toBe(true);
  });
});

describe("parseClientMessage", () => {
  const parse = (value: unknown) => parseClientMessage(JSON.stringify(value));

  it("accepts every message in the protocol", () => {
    const messages: ClientMessage[] = [
      { type: "configure", rules: { targetScore: 5000, entryThreshold: 500 } },
      { type: "configure", rules: {} },
      { type: "start" },
      { type: "leave" },
      { type: "intent", seq: 0, intent: { type: "roll" } },
      { type: "intent", seq: 4, intent: { type: "keepAndRoll" } },
      { type: "intent", seq: 4, intent: { type: "toggleDie", index: 5 } },
      { type: "intent", seq: 4, intent: { type: "bank" } },
      { type: "intent", seq: 4, intent: { type: "passTurn" } },
      { type: "seen", seq: 12 },
      { type: "rematch", gameNumber: 1 },
      { type: "react", reaction: "thumbsUp" },
      { type: "react", reaction: "skull" },
    ];
    for (const message of messages) expect(parse(message)).toEqual(message);
  });

  it("drops fields it doesn't know", () => {
    expect(parse({ type: "configure", rules: { targetScore: 5000, scoring: { singleOne: 9999 } }, x: 1 })).toEqual({
      type: "configure",
      rules: { targetScore: 5000 },
    });
    expect(parse({ type: "intent", seq: 0, intent: { type: "roll", values: [6, 6, 6, 6, 6, 6] } })).toEqual({
      type: "intent",
      seq: 0,
      intent: { type: "roll" },
    });
  });

  it("refuses dice values sent by a client", () => {
    expect(parse({ type: "intent", seq: 1, intent: { type: "rolled", values: [1, 1, 1, 1, 1, 1] } })).toBeNull();
  });

  it.each([
    ["binary", new ArrayBuffer(4)],
    ["not JSON", "{"],
    ["a JSON string", '"start"'],
    ["null", "null"],
    ["an array", "[]"],
    ["an unknown type", '{"type":"shuffle"}'],
    ["no type", "{}"],
    ["intent without seq", '{"type":"intent","intent":{"type":"roll"}}'],
    ["a negative seq", '{"type":"intent","seq":-1,"intent":{"type":"roll"}}'],
    ["a fractional seq", '{"type":"intent","seq":1.5,"intent":{"type":"roll"}}'],
    ["a string seq", '{"type":"intent","seq":"1","intent":{"type":"roll"}}'],
    ["intent without an intent", '{"type":"intent","seq":1}'],
    ["an unknown intent", '{"type":"intent","seq":1,"intent":{"type":"cheat"}}'],
    ["a die that doesn't exist", '{"type":"intent","seq":1,"intent":{"type":"toggleDie","index":6}}'],
    ["a reaction it doesn't know", '{"type":"react","reaction":"poop"}'],
    ["an emoji instead of a reaction's name", '{"type":"react","reaction":"🔥"}'],
    ["a reaction without a name", '{"type":"react"}'],
    ["a toggle without an index", '{"type":"intent","seq":1,"intent":{"type":"toggleDie"}}'],
    ["seen without seq", '{"type":"seen"}'],
    ["rematch without a game number", '{"type":"rematch"}'],
    ["configure without rules", '{"type":"configure"}'],
    ["a target that's too low", '{"type":"configure","rules":{"targetScore":100}}'],
    ["a target that's too high", '{"type":"configure","rules":{"targetScore":100001}}'],
    ["a fractional target", '{"type":"configure","rules":{"targetScore":5000.5}}'],
    ["a negative threshold", '{"type":"configure","rules":{"entryThreshold":-500}}'],
    ["a string threshold", '{"type":"configure","rules":{"entryThreshold":"500"}}'],
  ])("returns null for %s", (_label, data) => {
    expect(parseClientMessage(data)).toBeNull();
  });
});

describe("names, devices, intents", () => {
  it("cleans the name a device connected with", () => {
    expect(parsePlayerName(null)).toBeNull();
    expect(parsePlayerName("   ")).toBeNull();
    expect(parsePlayerName("  Ada   Lovelace ")).toBe("Ada Lovelace");
    expect(parsePlayerName("x".repeat(50))).toHaveLength(20);
  });

  it("wants device ids of a sensible length", () => {
    expect(isDeviceId("short")).toBe(false);
    expect(isDeviceId("x".repeat(16))).toBe(true);
    expect(isDeviceId("x".repeat(129))).toBe(false);
  });

  it("knows the two connect intents", () => {
    expect(isRoomIntent("host")).toBe(true);
    expect(isRoomIntent("join")).toBe(true);
    expect(isRoomIntent("Host")).toBe(false);
    expect(isRoomIntent(null)).toBe(false);
  });
});

describe("viewOf and presenceOf", () => {
  it("marks seats with an open socket, however many sockets they have", () => {
    expect(presenceOf(lobby(3), [2, 0, 0])).toEqual([true, false, true]);
    expect(presenceOf(lobby(2), [])).toEqual([false, false]);
  });

  it("shows the lobby without device ids", () => {
    const view = viewOf(lobby(2, ["Ada", "Bo"]), "ABCDEF", [true, false]);
    expect(view).toEqual({
      phase: "lobby",
      code: "ABCDEF",
      seats: [
        { name: "Ada", connected: true },
        { name: "Bo", connected: false },
      ],
      rules: DEFAULT_RULES,
    });
    expect(JSON.stringify(view)).not.toContain("device-");
  });

  it("shows a game with its whole log and everyone's seen mark", () => {
    const room = move(playing(2, ["Ada", "Bo"]), 0, { type: "roll" });
    const view = viewOf(room, "ABCDEF", [true, true]);
    expect(view).toMatchObject({ phase: "playing", code: "ABCDEF", gameNumber: 1, seen: [0, 0] });
    expect(view.phase === "playing" && view.log).toEqual(room.log);
    expect(JSON.stringify(view)).not.toContain("device-");
  });
});

describe("summaryOf", () => {
  it("says missing, or not seated", () => {
    expect(summaryOf(null, device(0))).toEqual({ status: "missing" });
    expect(summaryOf(lobby(2), device(7))).toEqual({ status: "notSeated" });
  });

  it("lists the lobby and who the host is", () => {
    const room = lobby(2, ["Ada", "Bo"]);
    expect(summaryOf(room, device(0))).toEqual({ status: "lobby", seats: ["Ada", "Bo"], isHost: true });
    expect(summaryOf(room, device(1))).toEqual({ status: "lobby", seats: ["Ada", "Bo"], isHost: false });
  });

  it("says whose turn it is, the scores, and how much each player has missed", () => {
    let room = bankThousand(playing(2, ["Ada", "Bo"]), 0);
    const length = room.log.length;
    const seen = applyMessage(room, 0, { type: "seen", seq: length });
    if (seen.kind === "seen") room = seen.room;
    expect(summaryOf(room, device(0))).toEqual({
      status: "theirTurn",
      seats: ["Ada", "Bo"],
      scores: [1000, 0],
      current: "Bo",
      unseen: 0,
    });
    expect(summaryOf(room, device(1))).toEqual({
      status: "yourTurn",
      seats: ["Ada", "Bo"],
      scores: [1000, 0],
      current: "Bo",
      unseen: length,
    });
  });

  it("names the winners when the game is over", () => {
    expect(summaryOf(finished(), device(1))).toEqual({
      status: "over",
      seats: ["Ada", "Bo"],
      scores: [1000, 0],
      winners: [0],
      mySeat: 1,
    });
  });
});

describe("cancellationOf", () => {
  it("lets only the host call off a room, and only in the lobby", () => {
    expect(cancellationOf(null, device(0))).toBe("gone");
    expect(cancellationOf(lobby(3), device(0))).toBe("delete");
    expect(cancellationOf(lobby(3), device(1))).toBe("notHost");
    expect(cancellationOf(lobby(3), device(9))).toBe("notHost");
    expect(cancellationOf(playing(2), device(0))).toBe("started");
  });
});

describe("lifetimeOf", () => {
  it("keeps a lobby 7 days, a game in progress 30, a finished game 7", () => {
    expect(lifetimeOf(lobby(1))).toBe(LOBBY_LIFETIME_MS);
    expect(lifetimeOf(playing(2))).toBe(IDLE_GAME_LIFETIME_MS);
    expect(lifetimeOf(finished())).toBe(FINISHED_GAME_LIFETIME_MS);
  });
});
