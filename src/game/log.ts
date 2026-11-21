/**
 * The game log: every game (local or online) is its input plus an append-only list of machine
 * events. Replaying the log through the machine gives the current state, so the log is what gets
 * saved, sent over the network, and replayed to players who missed turns.
 *
 * Players never send machine events directly. They send *intents* (`roll`, `bank`, ...), and
 * `applyIntent` turns an intent into the log entries it produces. A throw becomes two entries,
 * `roll`/`keepAndRoll` then `rolled { values }`, with the values picked here by whoever is
 * authoritative (the Durable Object online, the device for local games), never by the physics.
 *
 * This module is shared by the browser and the Worker: keep it free of DOM and React.
 */
import { initialTransition, isUnhandled, transition, type EventFromLogic, type SnapshotFrom } from "xstate";
import { farkleMachine, freeDiceIndices, type GameInput } from "./machine";
import type { DieValue } from "./scoring";

export type GameEvent = EventFromLogic<typeof farkleMachine>;
export type GameSnapshot = SnapshotFrom<typeof farkleMachine>;

/** What a player can ask for. `rolled` is not an intent: dice values come from `applyIntent`. */
export type Intent =
  | { type: "roll" }
  | { type: "keepAndRoll" }
  | { type: "toggleDie"; index: number }
  | { type: "bank" }
  | { type: "passTurn" };

export interface LogEntry {
  /** Position in the log, starting at 0. Always equal to the entry's index. */
  seq: number;
  /** Seat (player index) whose intent produced this entry. */
  seat: number;
  event: GameEvent;
}

export type IntentRejection = "notYourTurn" | "notAllowed" | "gameOver";

export type IntentResult = { ok: true; entries: LogEntry[] } | { ok: false; reason: IntentRejection };

/** Snapshot after applying `entries` to a fresh game. Pure: starts no actor, runs no effects. */
export function replayLog(input: GameInput, entries: readonly LogEntry[]): GameSnapshot {
  let [snapshot] = initialTransition(farkleMachine, input);
  for (const entry of entries) [snapshot] = transition(farkleMachine, snapshot, entry.event);
  return snapshot;
}

/** Applies one event, or returns null if the machine would ignore it. */
export function step(snapshot: GameSnapshot, event: GameEvent): GameSnapshot | null {
  const result = transition(farkleMachine, snapshot, event);
  return isUnhandled(snapshot, result) ? null : result[0];
}

/**
 * Turns `seat`'s intent into the log entries it produces, given the game so far (`snapshot`
 * must be `replayLog(input, log)`, and `nextSeq` the log's length).
 * `randomDie` supplies throw results: use `secureRandomDie` outside tests.
 */
export function applyIntent(
  snapshot: GameSnapshot,
  nextSeq: number,
  seat: number,
  intent: Intent,
  randomDie: () => DieValue = secureRandomDie,
): IntentResult {
  if (snapshot.status !== "active") return { ok: false, reason: "gameOver" };
  if (snapshot.context.current !== seat) return { ok: false, reason: "notYourTurn" };

  const events: GameEvent[] = [intent];
  let next = step(snapshot, intent);
  if (!next) return { ok: false, reason: "notAllowed" };

  if (intent.type === "roll" || intent.type === "keepAndRoll") {
    const count = freeDiceIndices(next.context).length;
    const rolled: GameEvent = { type: "rolled", values: Array.from({ length: count }, randomDie) };
    next = step(next, rolled);
    if (!next) return { ok: false, reason: "notAllowed" };
    events.push(rolled);
  }

  return { ok: true, entries: events.map((event, i) => ({ seq: nextSeq + i, seat, event })) };
}

/** True for the entry that starts a throw; the entry after it is always the matching `rolled`. */
export const isThrowStart = (event: GameEvent): boolean => event.type === "roll" || event.type === "keepAndRoll";

/** A fair die roll from the platform CSPRNG (browsers and Workers both have `crypto`). */
export function secureRandomDie(): DieValue {
  const buffer = new Uint8Array(1);
  // Rejection sampling: 252 is the largest multiple of 6 below 256, so every face is equally likely.
  for (;;) {
    crypto.getRandomValues(buffer);
    const byte = buffer[0]!;
    if (byte < 252) return ((byte % 6) + 1) as DieValue;
  }
}
