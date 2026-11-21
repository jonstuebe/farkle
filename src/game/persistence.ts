/**
 * Save / resume for the running game, plus the remembered setup-screen preferences.
 *
 * What is stored (localStorage key `farkle.save.v1`):
 *   { version, savedAt, input, snapshot }
 * where `snapshot` is `actor.getPersistedSnapshot()` and `input` is the `GameInput` the game was
 * started with (needed for "play again with the same players").
 *
 * Rules this module enforces:
 *  - Only an *active* game is saved. When the game reaches `gameOver` the save is cleared.
 *  - **Mid-roll saves are never written.** While the machine is in `playing.rolling` the outcome
 *    lives in the physics simulation, which does not survive a reload. So the save keeps pointing
 *    at the last settled state (`awaitingRoll`, `choosing` or `farkled`): after a reload the player
 *    is back where they were just before pressing Roll / Keep & roll and simply throws again.
 *    Nothing is lost or gained: a throw only counts once the scene reports `rolled`.
 *  - Stored data is untrusted: wrong version, broken JSON, an impossible context or a state the
 *    machine does not have all mean "no save" (and the bad entry is removed).
 *
 * Bump `SAVE_VERSION` whenever the machine's states or context shape change.
 */
import { createActor, type Actor } from "xstate";
import { restoreActor } from "xstate/persist";
import { DEFAULT_RULES, farkleMachine, type GameContext, type GameInput, type Player } from "./machine";
import { DICE_COUNT } from "./scoring";

export type GameActor = Actor<typeof farkleMachine>;

export const SAVE_VERSION = 1;
export const SAVE_KEY = "farkle.save.v1";
export const PREFS_KEY = "farkle.setup.v1";
export const MAX_PLAYERS = 8;

/** The subset of `Storage` used here, so tests can pass a plain in-memory object. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface SavedGame {
  version: number;
  /** `Date.now()` at the time of the save. */
  savedAt: number;
  input: GameInput;
  /** Result of `actor.getPersistedSnapshot()`; opaque outside this module. */
  snapshot: PersistedGame;
}

/** What the setup screen shows on its "Resume game" card. */
export interface SavedGameSummary {
  players: Player[];
  /** Index of the player whose turn it is. */
  current: number;
  targetScore: number;
  finalRound: boolean;
  savedAt: number;
}

type SettledState = "awaitingRoll" | "choosing" | "farkled";
const SETTLED_STATES: readonly string[] = ["awaitingRoll", "choosing", "farkled"] satisfies SettledState[];

interface PersistedGame {
  status: "active";
  value: { playing: SettledState };
  context: GameContext;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Storage access (never throws: private mode, quota, SSR, disabled storage)
// ---------------------------------------------------------------------------

function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(store: KeyValueStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: KeyValueStore | null, key: string, value: string): boolean {
  try {
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function remove(store: KeyValueStore | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // nothing useful to do
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isIndex = (v: unknown, length: number): v is number => isCount(v) && v < length;

function isValidInput(v: unknown): v is GameInput {
  if (!isRecord(v) || !Array.isArray(v.players)) return false;
  if (v.players.length < 1 || v.players.length > MAX_PLAYERS) return false;
  if (!v.players.every((name) => typeof name === "string" && name.length > 0)) return false;
  return v.rules === undefined || isRecord(v.rules);
}

function isValidContext(v: unknown): v is GameContext {
  if (!isRecord(v)) return false;
  const { rules, players, current, turnPoints, dice, selected, finalRoundBy } = v;
  if (!isRecord(rules) || !isRecord(rules.scoring)) return false;
  if (!isCount(rules.targetScore) || rules.targetScore < 1 || !isCount(rules.entryThreshold)) return false;
  if (!Array.isArray(players) || players.length < 1 || players.length > MAX_PLAYERS) return false;
  if (!players.every((p) => isRecord(p) && typeof p.name === "string" && isCount(p.score))) return false;
  if (!isIndex(current, players.length) || !isCount(turnPoints)) return false;
  if (!Array.isArray(dice) || dice.length !== DICE_COUNT) return false;
  const dieOk = (d: unknown) =>
    isRecord(d) && typeof d.held === "boolean" && (d.value === null || (isCount(d.value) && d.value >= 1 && d.value <= 6));
  if (!dice.every(dieOk)) return false;
  if (!Array.isArray(selected) || !selected.every((i) => isIndex(i, DICE_COUNT))) return false;
  return finalRoundBy === null || isIndex(finalRoundBy, players.length);
}

function isValidSnapshot(v: unknown): v is PersistedGame {
  if (!isRecord(v) || v.status !== "active") return false;
  if (!isRecord(v.value) || typeof v.value.playing !== "string") return false;
  if (!SETTLED_STATES.includes(v.value.playing)) return false;
  return isValidContext(v.context);
}

/** Parse and validate stored JSON. Returns null for anything that is not a resumable save. */
export function parseSavedGame(raw: string | null | undefined): SavedGame | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || data.version !== SAVE_VERSION) return null;
  if (!isValidInput(data.input) || !isValidSnapshot(data.snapshot)) return null;
  if (data.input.players.length !== data.snapshot.context.players.length) return null;
  // Last line of defence: let XState check the snapshot against the real machine.
  if (!tryRestore(data.snapshot)) return null;
  return {
    version: SAVE_VERSION,
    savedAt: typeof data.savedAt === "number" ? data.savedAt : 0,
    input: data.input,
    snapshot: data.snapshot,
  };
}

function tryRestore(snapshot: PersistedGame): GameActor | null {
  try {
    // Deep-copied so the live actor never shares objects with the parsed save.
    const actor = restoreActor(farkleMachine, structuredClone(snapshot) as never);
    return actor.getSnapshot().status === "active" ? actor : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Save / load / clear
// ---------------------------------------------------------------------------

/**
 * JSON for the actor's current state, or null when that state must not be saved
 * (mid-roll, finished, stopped or errored).
 */
export function serializeGame(actor: GameActor, input: GameInput, now: number = Date.now()): string | null {
  const live = actor.getSnapshot();
  if (live.status !== "active" || live.matches({ playing: "rolling" })) return null;
  const saved = { version: SAVE_VERSION, savedAt: now, input, snapshot: actor.getPersistedSnapshot() };
  try {
    return JSON.stringify(saved);
  } catch {
    return null;
  }
}

/** The saved in-progress game, if there is a usable one. Unusable data is deleted. */
export function loadSavedGame(store: KeyValueStore | null = defaultStore()): SavedGame | null {
  const raw = read(store, SAVE_KEY);
  if (raw === null) return null;
  const saved = parseSavedGame(raw);
  if (!saved) remove(store, SAVE_KEY);
  return saved;
}

export function clearSavedGame(store: KeyValueStore | null = defaultStore()): void {
  remove(store, SAVE_KEY);
}

export function summarizeSavedGame(saved: SavedGame): SavedGameSummary {
  const { players, current, rules, finalRoundBy } = saved.snapshot.context;
  return {
    players: players.map((p) => ({ ...p })),
    current,
    targetScore: rules.targetScore,
    finalRound: finalRoundBy !== null,
    savedAt: saved.savedAt,
  };
}

/** A fresh, not-yet-started actor for a new game. Pass it to `<FarkleContext.Provider actor>`. */
export function createGame(input: GameInput): GameActor {
  return createActor(farkleMachine, { input });
}

/**
 * A not-yet-started actor continuing a saved game, or null if the save can't be restored.
 * Pass it to `<FarkleContext.Provider actor>`, which starts it. Create it once per resume.
 */
export function restoreGame(saved: SavedGame): GameActor | null {
  return tryRestore(saved.snapshot);
}

/**
 * Keep the save in step with `actor`: writes now and after every snapshot change, skips
 * mid-roll states, and clears the save once the game is over. Returns an unsubscribe function.
 */
export function persistGame(
  actor: GameActor,
  input: GameInput,
  store: KeyValueStore | null = defaultStore(),
): () => void {
  let last: string | null = null;
  const sync = () => {
    const status = actor.getSnapshot().status;
    if (status === "done") {
      clearSavedGame(store);
      return;
    }
    const json = serializeGame(actor, input);
    if (json === null || json === last) return;
    if (write(store, SAVE_KEY, json)) last = json;
  };
  sync();
  const subscription = actor.subscribe({ next: sync, error: () => {}, complete: sync });
  return () => subscription.unsubscribe();
}

// ---------------------------------------------------------------------------
// Setup-screen preferences (last-used roster and rules)
// ---------------------------------------------------------------------------

export interface SetupPrefs {
  players: string[];
  targetScore: number;
  entryThreshold: number;
}

export const DEFAULT_PREFS: SetupPrefs = {
  players: ["Player 1", "Player 2"],
  targetScore: DEFAULT_RULES.targetScore,
  entryThreshold: DEFAULT_RULES.entryThreshold,
};

export const MIN_TARGET_SCORE = 500;
export const MAX_TARGET_SCORE = 100_000;
export const MAX_NAME_LENGTH = 16;

export function loadSetupPrefs(store: KeyValueStore | null = defaultStore()): SetupPrefs {
  const fallback = { ...DEFAULT_PREFS, players: [...DEFAULT_PREFS.players] };
  try {
    const data: unknown = JSON.parse(read(store, PREFS_KEY) ?? "null");
    if (!isRecord(data)) return fallback;
    const players = Array.isArray(data.players)
      ? data.players
          .filter((n): n is string => typeof n === "string")
          .map((n) => n.trim().slice(0, MAX_NAME_LENGTH))
          .filter((n) => n.length > 0)
          .slice(0, MAX_PLAYERS)
      : [];
    const target = data.targetScore;
    const targetOk = isCount(target) && target >= MIN_TARGET_SCORE && target <= MAX_TARGET_SCORE;
    return {
      players: players.length > 0 ? players : fallback.players,
      targetScore: targetOk ? target : fallback.targetScore,
      entryThreshold: isCount(data.entryThreshold) ? data.entryThreshold : fallback.entryThreshold,
    };
  } catch {
    return fallback;
  }
}

export function saveSetupPrefs(prefs: SetupPrefs, store: KeyValueStore | null = defaultStore()): void {
  write(store, PREFS_KEY, JSON.stringify(prefs));
}
