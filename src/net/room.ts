/**
 * Server-side room logic for online play, as pure functions. The Room Durable Object
 * (worker/index.ts) is thin I/O around these: it loads a Room, calls one function, saves the
 * result, and sends what the Outcome says to send.
 *
 * Nothing here touches storage, sockets, or the clock. The wire format is in ./protocol.ts.
 */
import { DEFAULT_RULES, type GameRules } from "../game/machine";
import { DICE_COUNT, type DieValue } from "../game/scoring";
import { applyIntent, replayLog, step, type GameSnapshot, type Intent, type LogEntry } from "../game/log";
import {
  DEVICE_ID_MIN_LENGTH,
  FINISHED_GAME_LIFETIME_MS,
  IDLE_GAME_LIFETIME_MS,
  LOBBY_LIFETIME_MS,
  MAX_SEATS,
  MIN_SEATS,
  cleanPlayerName,
  type ClientMessage,
  type Refusal,
  type RoomSummary,
  type RoomView,
} from "./protocol";

// ---------------------------------------------------------------------------------------------
// Room state (what the Durable Object stores)
// ---------------------------------------------------------------------------------------------

export const HOST_SEAT = 0;

/** Same limits as the local setup screen (src/game/persistence.ts). */
export const TARGET_SCORE_MIN = 500;
export const TARGET_SCORE_MAX = 100_000;

export interface Seat {
  /** The device id that holds this seat. Never sent to other players. */
  device: string;
  name: string;
}

export interface LobbyRoom {
  phase: "lobby";
  /** Seat 0 is the host. */
  seats: Seat[];
  rules: GameRules;
}

export interface PlayingRoom {
  phase: "playing";
  seats: Seat[];
  gameNumber: number;
  /** The names here are frozen when the game starts; `seats[i].name` can change on reconnect. */
  input: { players: string[]; rules: GameRules };
  log: LogEntry[];
  /** Per seat: how many log entries that player has watched. */
  seen: number[];
}

export type Room = LobbyRoom | PlayingRoom;

export type RoomIntent = "host" | "join";

export const isRoomIntent = (value: unknown): value is RoomIntent => value === "host" || value === "join";

export const isDeviceId = (value: string): boolean => value.length >= DEVICE_ID_MIN_LENGTH && value.length <= 128;

const defaultName = (seat: number): string => `Player ${seat + 1}`;

// ---------------------------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------------------------

export const seatOfDevice = (room: Room, device: string): number | null => {
  const seat = room.seats.findIndex((s) => s.device === device);
  return seat === -1 ? null : seat;
};

export type Seating = { ok: true; room: Room; seat: number } | { ok: false; reason: Refusal };

/**
 * Gives `device` its seat, creating the room for a host or adding a seat in the lobby.
 * `name` is what the device connected with (already cleaned); null keeps the name it had.
 * The returned room is the same object when nothing changed.
 *
 * NOTE: a "host" intent on a room that already exists is treated as a join. A device only hosts
 * a code it just made up, so this only happens when two hosts pick the same code (1 in 2^30).
 */
export function seat(room: Room | null, device: string, intent: RoomIntent, name: string | null): Seating {
  if (!room) {
    if (intent !== "host") return { ok: false, reason: "missing" };
    const opened: LobbyRoom = {
      phase: "lobby",
      seats: [{ device, name: name ?? defaultName(HOST_SEAT) }],
      rules: DEFAULT_RULES,
    };
    return { ok: true, room: opened, seat: HOST_SEAT };
  }

  const existing = seatOfDevice(room, device);
  if (existing !== null) {
    const current = room.seats[existing]!;
    if (name === null || name === current.name) return { ok: true, room, seat: existing };
    const seats = room.seats.map((s, i) => (i === existing ? { ...s, name } : s));
    return { ok: true, room: { ...room, seats }, seat: existing };
  }

  if (room.phase !== "lobby") return { ok: false, reason: "started" };
  if (room.seats.length >= MAX_SEATS) return { ok: false, reason: "full" };
  const index = room.seats.length;
  return {
    ok: true,
    room: { ...room, seats: [...room.seats, { device, name: name ?? defaultName(index) }] },
    seat: index,
  };
}

// ---------------------------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------------------------

type RuleChanges = Extract<ClientMessage, { type: "configure" }>["rules"];

/** Host only, lobby only. Returns the same room when refused or when nothing changes. */
export function configure(room: Room, bySeat: number, changes: RuleChanges): Room {
  if (room.phase !== "lobby" || bySeat !== HOST_SEAT) return room;
  const targetScore = changes.targetScore ?? room.rules.targetScore;
  const entryThreshold = changes.entryThreshold ?? room.rules.entryThreshold;
  if (targetScore === room.rules.targetScore && entryThreshold === room.rules.entryThreshold) return room;
  // A threshold above the target could never be reached before the game ends.
  if (entryThreshold > targetScore) return room;
  return { ...room, rules: { ...room.rules, targetScore, entryThreshold } };
}

const deal = (seats: Seat[], rules: GameRules, gameNumber: number): PlayingRoom => ({
  phase: "playing",
  seats,
  gameNumber,
  input: { players: seats.map((s) => s.name), rules },
  log: [],
  seen: seats.map(() => 0),
});

/** Host only, lobby only, needs MIN_SEATS. Returns the same room when refused. */
export function start(room: Room, bySeat: number): Room {
  if (room.phase !== "lobby" || bySeat !== HOST_SEAT || room.seats.length < MIN_SEATS) return room;
  return deal(room.seats, room.rules, 1);
}

// ---------------------------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------------------------

// Replaying a long log on every tap adds up, so the snapshot for each log array is remembered.
// Logs are never mutated (appending makes a new array), so the array itself is a safe key.
const snapshots = new WeakMap<readonly LogEntry[], GameSnapshot>();

export function snapshotOf(room: PlayingRoom): GameSnapshot {
  let snapshot = snapshots.get(room.log);
  if (!snapshot) {
    snapshot = replayLog(room.input, room.log);
    snapshots.set(room.log, snapshot);
  }
  return snapshot;
}

export const isGameOver = (room: PlayingRoom): boolean => snapshotOf(room).status !== "active";

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/**
 * What the Durable Object does after a message:
 * - `ignored`: nothing.
 * - `rejected`: nothing changed; send the sender a fresh `room` so their screen catches up.
 * - `room`: save, then send everyone a `room` (lobby change, start, rematch).
 * - `appended`: save, then send everyone `appended` with `entries`.
 * - `seen`: save; nobody needs telling.
 */
export type Outcome =
  | { kind: "ignored" }
  | { kind: "rejected" }
  | { kind: "room"; room: Room }
  | { kind: "appended"; room: PlayingRoom; entries: LogEntry[] }
  | { kind: "seen"; room: PlayingRoom };

const REJECTED: Outcome = { kind: "rejected" };

const changed = (before: Room, after: Room): Outcome => (after === before ? REJECTED : { kind: "room", room: after });

export function applyMessage(
  room: Room,
  bySeat: number,
  message: ClientMessage,
  randomDie?: () => DieValue,
): Outcome {
  if (!room.seats[bySeat]) return { kind: "ignored" };

  switch (message.type) {
    case "configure":
      // Re-sending the rules the room already has is not worth a reply.
      if (room.phase === "lobby" && bySeat === HOST_SEAT && configure(room, bySeat, message.rules) === room) {
        const { targetScore = room.rules.targetScore, entryThreshold = room.rules.entryThreshold } = message.rules;
        const same = targetScore === room.rules.targetScore && entryThreshold === room.rules.entryThreshold;
        return same ? { kind: "ignored" } : REJECTED;
      }
      return changed(room, configure(room, bySeat, message.rules));

    case "start":
      return changed(room, start(room, bySeat));

    case "intent": {
      if (room.phase !== "playing" || message.seq !== room.log.length) return REJECTED;
      const result = applyIntent(snapshotOf(room), room.log.length, bySeat, message.intent, randomDie);
      if (!result.ok) return REJECTED;
      const log = [...room.log, ...result.entries];
      let snapshot: GameSnapshot | null = snapshotOf(room);
      for (const entry of result.entries) snapshot = snapshot && step(snapshot, entry.event);
      if (snapshot) snapshots.set(log, snapshot);
      return { kind: "appended", room: { ...room, log }, entries: result.entries };
    }

    case "seen": {
      if (room.phase !== "playing") return { kind: "ignored" };
      const seq = Math.min(message.seq, room.log.length);
      if (seq <= (room.seen[bySeat] ?? 0)) return { kind: "ignored" };
      return { kind: "seen", room: { ...room, seen: room.seen.map((n, i) => (i === bySeat ? seq : n)) } };
    }

    case "rematch": {
      if (room.phase !== "playing") return REJECTED;
      // Two players tapping Rematch at once: the second one is already in the new game.
      if (message.gameNumber !== room.gameNumber || !isGameOver(room)) return REJECTED;
      return { kind: "room", room: deal(room.seats, room.input.rules, room.gameNumber + 1) };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Validating what a socket sent
// ---------------------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function parseIntent(value: unknown): Intent | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "roll":
    case "keepAndRoll":
    case "bank":
    case "passTurn":
      return { type: value.type };
    case "toggleDie":
      return isCount(value.index) && value.index < DICE_COUNT ? { type: "toggleDie", index: value.index } : null;
    default:
      return null;
  }
}

function parseRuleChanges(value: unknown): RuleChanges | null {
  if (!isObject(value)) return null;
  const changes: RuleChanges = {};
  if (value.targetScore !== undefined) {
    const target = value.targetScore;
    if (!isCount(target) || target < TARGET_SCORE_MIN || target > TARGET_SCORE_MAX) return null;
    changes.targetScore = target;
  }
  if (value.entryThreshold !== undefined) {
    const entry = value.entryThreshold;
    if (!isCount(entry) || entry > TARGET_SCORE_MAX) return null;
    changes.entryThreshold = entry;
  }
  return changes;
}

/**
 * A ClientMessage from a JSON text frame, or null for anything else. Builds a fresh object from
 * the known fields only, so extra keys (a `scoring` table, a `rolled` event) never get through.
 */
export function parseClientMessage(data: unknown): ClientMessage | null {
  if (typeof data !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;

  switch (value.type) {
    case "configure": {
      const rules = parseRuleChanges(value.rules);
      return rules && { type: "configure", rules };
    }
    case "start":
      return { type: "start" };
    case "intent": {
      const intent = parseIntent(value.intent);
      return intent && isCount(value.seq) ? { type: "intent", seq: value.seq, intent } : null;
    }
    case "seen":
      return isCount(value.seq) ? { type: "seen", seq: value.seq } : null;
    case "rematch":
      return isCount(value.gameNumber) ? { type: "rematch", gameNumber: value.gameNumber } : null;
    default:
      return null;
  }
}

/** The name a device connected with, or null when it sent none worth keeping. */
export const parsePlayerName = (raw: string | null): string | null => (raw === null ? null : cleanPlayerName(raw));

// ---------------------------------------------------------------------------------------------
// What clients see
// ---------------------------------------------------------------------------------------------

/** `connected[i]`: seat i has an open socket. */
export function presenceOf(room: Room, connectedSeats: Iterable<number>): boolean[] {
  const open = new Set(connectedSeats);
  return room.seats.map((_, i) => open.has(i));
}

export function viewOf(room: Room, code: string, connected: readonly boolean[]): RoomView {
  const seats = room.seats.map((s, i) => ({ name: s.name, connected: connected[i] ?? false }));
  if (room.phase === "lobby") return { phase: "lobby", code, seats, rules: room.rules };
  return {
    phase: "playing",
    code,
    seats,
    gameNumber: room.gameNumber,
    input: room.input,
    log: room.log,
    seen: room.seen,
  };
}

export function summaryOf(room: Room | null, device: string): RoomSummary {
  if (!room) return { status: "missing" };
  const mySeat = seatOfDevice(room, device);
  if (mySeat === null) return { status: "notSeated" };
  const seats = room.seats.map((s) => s.name);
  if (room.phase === "lobby") return { status: "lobby", seats, isHost: mySeat === HOST_SEAT };

  const snapshot = snapshotOf(room);
  const { players, current } = snapshot.context;
  const scores = players.map((p) => p.score);
  if (snapshot.status !== "active") {
    const top = Math.max(...scores);
    const winners = scores.flatMap((score, i) => (score === top ? [i] : []));
    return { status: "over", seats, scores, winners, mySeat };
  }
  return {
    status: current === mySeat ? "yourTurn" : "theirTurn",
    seats,
    scores,
    current: seats[current] ?? "",
    unseen: room.log.length - (room.seen[mySeat] ?? 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Cancelling and expiry
// ---------------------------------------------------------------------------------------------

/** Only the host can call off a room, and only while it's still in the lobby. */
export type Cancellation = "delete" | "gone" | "started" | "notHost";

export function cancellationOf(room: Room | null, device: string): Cancellation {
  if (!room) return "gone";
  if (seatOfDevice(room, device) !== HOST_SEAT) return "notHost";
  return room.phase === "lobby" ? "delete" : "started";
}

/** How long a room is kept after its last change. */
export function lifetimeOf(room: Room): number {
  if (room.phase === "lobby") return LOBBY_LIFETIME_MS;
  return isGameOver(room) ? FINISHED_GAME_LIFETIME_MS : IDLE_GAME_LIFETIME_MS;
}
