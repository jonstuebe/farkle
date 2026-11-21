/**
 * Save / resume for the local (pass-and-play) game, plus the remembered setup-screen preferences.
 * Online games live in their Room on the server; this module only stores local ones.
 *
 * What is stored (localStorage key `farkle.save.v2`):
 *   { version, savedAt, input, log }
 * i.e. the game's input and its event log (see ./log.ts). Resuming replays the log, so a save can
 * never hold a state the machine couldn't reach. Throws are atomic in the log (`roll` + `rolled`
 * are appended together), so there is no mid-roll state to worry about: reloading during a throw
 * animation simply shows its result.
 *
 * Rules this module enforces:
 *  - Only an unfinished game is saved; when the game ends the save is cleared.
 *  - Stored data is untrusted: wrong version, broken JSON, a malformed log or one the machine
 *    rejects all mean "no save" (and the bad entry is removed).
 */
import { initialTransition } from "xstate";
import { DEFAULT_RULES, farkleMachine, type GameInput, type Player } from "./machine";
import { replayLog, step, type GameEvent, type LogEntry } from "./log";
import type { GameSession, SessionState } from "./session";

export const SAVE_VERSION = 2;
export const SAVE_KEY = "farkle.save.v2";
/** Version-1 saves (xstate snapshots) can't be converted to a log; they are just removed. */
const LEGACY_SAVE_KEY = "farkle.save.v1";
export const PREFS_KEY = "farkle.setup.v1";
export const MAX_PLAYERS = 8;

/** The subset of `Storage` used here, so tests can pass a plain in-memory object. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface SavedGame {
  version: number;
  /** `Date.now()` at the time of the save. */
  savedAt: number;
  input: GameInput;
  log: LogEntry[];
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

function isValidInput(v: unknown): v is GameInput {
  if (!isRecord(v) || !Array.isArray(v.players)) return false;
  if (v.players.length < 1 || v.players.length > MAX_PLAYERS) return false;
  if (!v.players.every((name) => typeof name === "string" && name.length > 0)) return false;
  if (v.rules === undefined) return true;
  if (!isRecord(v.rules)) return false;
  const { targetScore, entryThreshold } = v.rules;
  return (targetScore === undefined || (isCount(targetScore) && targetScore > 0)) && (entryThreshold === undefined || isCount(entryThreshold));
}

/**
 * Checks a log's shape and that the machine accepts every event in order.
 * Returns false for anything malformed, out of order, or impossible.
 */
export function isValidLog(input: GameInput, log: unknown): log is LogEntry[] {
  if (!Array.isArray(log)) return false;
  let snapshot;
  try {
    [snapshot] = initialTransition(farkleMachine, input);
  } catch {
    return false;
  }
  for (let i = 0; i < log.length; i++) {
    const entry: unknown = log[i];
    if (!isRecord(entry) || entry.seq !== i || !isCount(entry.seat) || entry.seat >= input.players.length) return false;
    if (!isRecord(entry.event) || typeof entry.event.type !== "string") return false;
    const next = step(snapshot, entry.event as GameEvent);
    if (!next) return false;
    snapshot = next;
  }
  return true;
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
  if (!isValidInput(data.input) || !isValidLog(data.input, data.log)) return null;
  if (replayLog(data.input, data.log).status !== "active") return null;
  return {
    version: SAVE_VERSION,
    savedAt: typeof data.savedAt === "number" ? data.savedAt : 0,
    input: data.input,
    log: data.log,
  };
}

// ---------------------------------------------------------------------------
// Save / load / clear
// ---------------------------------------------------------------------------

/** JSON for a session's game, or null when it must not be saved (finished). */
export function serializeGame(state: Pick<SessionState, "input" | "log">, now: number = Date.now()): string | null {
  if (replayLog(state.input, state.log).status !== "active") return null;
  try {
    return JSON.stringify({ version: SAVE_VERSION, savedAt: now, input: state.input, log: state.log });
  } catch {
    return null;
  }
}

/** The saved in-progress game, if there is a usable one. Unusable data is deleted. */
export function loadSavedGame(store: KeyValueStore | null = defaultStore()): SavedGame | null {
  remove(store, LEGACY_SAVE_KEY);
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
  const { players, current, rules, finalRoundBy } = replayLog(saved.input, saved.log).context;
  return {
    players: players.map((p) => ({ ...p })),
    current,
    targetScore: rules?.targetScore ?? DEFAULT_RULES.targetScore,
    finalRound: finalRoundBy !== null,
    savedAt: saved.savedAt,
  };
}

/**
 * Keep the save in step with a local session: writes now and after every change, and clears
 * the save once the game is over. Returns an unsubscribe function.
 */
export function persistSession(session: GameSession, store: KeyValueStore | null = defaultStore()): () => void {
  let last: string | null = null;
  const sync = () => {
    const state = session.getState();
    const json = serializeGame(state);
    if (json === null) {
      clearSavedGame(store);
      last = null;
      return;
    }
    if (json !== last && write(store, SAVE_KEY, json)) last = json;
  };
  sync();
  return session.subscribe(sync);
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
