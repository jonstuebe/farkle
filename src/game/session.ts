/**
 * A game session owns the authoritative log for one game and accepts player intents.
 *
 * - Local (pass-and-play): this device is authoritative for every seat. Intents are applied
 *   right here with `applyIntent` (dice from the device CSPRNG).
 * - Online: the Room Durable Object is authoritative. The online session (src/net/) forwards
 *   intents over the WebSocket and appends entries as the server broadcasts them.
 *
 * UI code never reads the session's log directly; it reads the *presented* game from the
 * Presenter (./presenter.ts), which replays the log at a watchable pace.
 */
import type { GameInput } from "./machine";
import { applyIntent, replayLog, type Intent, type LogEntry } from "./log";
import type { Reaction } from "../net/protocol";

export interface SessionState {
  /** Changes on rematch; a new game number means a new log starting at seq 0. */
  gameNumber: number;
  input: GameInput;
  log: readonly LogEntry[];
  /** Seats this device plays: every seat locally, just one online. */
  mySeats: readonly number[];
  /** Log position this device had already watched when the game was opened (replay start). */
  seenFrom: number;
  /** Online only: false while reconnecting. Local sessions are always connected. */
  connected: boolean;
  /** Online only: which seats have an open connection right now (null for local games). */
  presence: readonly boolean[] | null;
}

export interface GameSession {
  readonly kind: "local" | "online";
  getState(): SessionState;
  /** Listener runs after every state change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Ask to make a move for the seat whose turn it is (must be one of `mySeats`). */
  sendIntent(intent: Intent): void;
  /** The player has watched the log up to (not including) `seq`. */
  markSeen(seq: number): void;
  /**
   * Online only: emoji reactions. `send` goes to everyone else in the room; `subscribe` hears
   * other players' reactions (never this device's own). Reactions are live only: not stored,
   * not replayed. Local sessions leave this undefined.
   */
  readonly reactions?: {
    send(reaction: Reaction): void;
    subscribe(listener: (seat: number, reaction: Reaction) => void): () => void;
  };
}

export interface LocalSessionOptions {
  input: GameInput;
  log?: readonly LogEntry[];
  gameNumber?: number;
  /** Called after every change (e.g. to save the game). */
  onChange?: (state: SessionState) => void;
}

/** Pass-and-play on one device. */
export function createLocalSession({ input, log = [], gameNumber = 1, onChange }: LocalSessionOptions): GameSession {
  const listeners = new Set<() => void>();
  const allSeats = input.players.map((_, i) => i);
  let state: SessionState = { gameNumber, input, log, mySeats: allSeats, seenFrom: log.length, connected: true, presence: null };
  let snapshot = replayLog(input, log);

  const commit = (next: SessionState) => {
    state = next;
    onChange?.(state);
    listeners.forEach((listener) => listener());
  };

  return {
    kind: "local",
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendIntent(intent) {
      const result = applyIntent(snapshot, state.log.length, snapshot.context.current, intent);
      if (!result.ok) return;
      const log = [...state.log, ...result.entries];
      snapshot = replayLog(input, log);
      commit({ ...state, log });
    },
    markSeen() {
      // Everyone shares one screen, so there is nothing to catch up on later.
    },
  };
}
