import { describe, expect, test } from "vitest";
import type { DieValue } from "./scoring";
import type { GameInput } from "./machine";
import { applyIntent, replayLog, type Intent, type LogEntry } from "./log";
import { createLocalSession } from "./session";
import {
  DEFAULT_PREFS,
  PREFS_KEY,
  SAVE_KEY,
  SAVE_VERSION,
  clearSavedGame,
  isValidLog,
  loadSavedGame,
  loadSetupPrefs,
  parseSavedGame,
  persistSession,
  saveSetupPrefs,
  serializeGame,
  summarizeSavedGame,
  type KeyValueStore,
} from "./persistence";

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  writes = 0;
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.writes++;
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const INPUT: GameInput = { players: ["Ada", "Bo"], rules: { targetScore: 5000, entryThreshold: 500 } };

/** Builds a log from intents with scripted dice. */
function buildLog(input: GameInput, steps: Array<[Intent, DieValue[]?]>): LogEntry[] {
  const log: LogEntry[] = [];
  for (const [intent, values = []] of steps) {
    let n = 0;
    const snapshot = replayLog(input, log);
    const result = applyIntent(snapshot, log.length, snapshot.context.current, intent, () => values[n++]!);
    if (!result.ok) throw new Error(`${intent.type}: ${result.reason}`);
    log.push(...result.entries);
  }
  return log;
}

/** Ada banks 1,000 (three 1s), then Bo rolls and selects a 5. */
const MID_GAME = buildLog(INPUT, [
  [{ type: "roll" }, [1, 1, 1, 2, 3, 4]],
  [{ type: "toggleDie", index: 0 }],
  [{ type: "toggleDie", index: 1 }],
  [{ type: "toggleDie", index: 2 }],
  [{ type: "bank" }],
  [{ type: "roll" }, [5, 2, 3, 4, 6, 6]],
  [{ type: "toggleDie", index: 0 }],
]);

const goodSave = () => JSON.parse(serializeGame({ input: INPUT, log: MID_GAME }, 123)!);

describe("save and restore", () => {
  test("round-trips a game in progress through JSON", () => {
    const store = new MemoryStore();
    store.setItem(SAVE_KEY, serializeGame({ input: INPUT, log: MID_GAME }, 42)!);
    const saved = loadSavedGame(store)!;
    expect(saved).toEqual({ version: SAVE_VERSION, savedAt: 42, input: INPUT, log: MID_GAME });
    const snapshot = replayLog(saved.input, saved.log);
    expect(snapshot.matches({ playing: "choosing" })).toBe(true);
    expect(snapshot.context.selected).toEqual([0]);
  });

  test("summarizes players and scores for the resume prompt", () => {
    const saved = parseSavedGame(JSON.stringify(goodSave()))!;
    expect(summarizeSavedGame(saved)).toEqual({
      players: [
        { name: "Ada", score: 1000 },
        { name: "Bo", score: 0 },
      ],
      current: 1,
      targetScore: 5000,
      finalRound: false,
      savedAt: 123,
    });
  });

  test("removes legacy v1 saves", () => {
    const store = new MemoryStore();
    store.setItem("farkle.save.v1", "{}");
    expect(loadSavedGame(store)).toBeNull();
    expect(store.getItem("farkle.save.v1")).toBeNull();
  });
});

describe("persistSession", () => {
  test("saves immediately and after every move, and clears when the game ends", () => {
    const store = new MemoryStore();
    const solo: GameInput = { players: ["Ada"], rules: { targetScore: 1000 } };
    const session = createLocalSession({ input: solo });
    const stop = persistSession(session, store);
    expect(parseSavedGame(store.getItem(SAVE_KEY))?.log).toEqual([]);

    session.sendIntent({ type: "roll" });
    expect(parseSavedGame(store.getItem(SAVE_KEY))?.log).toHaveLength(2);
    stop();
    session.sendIntent({ type: "roll" }); // ignored by the machine anyway; nothing new is written
    expect(parseSavedGame(store.getItem(SAVE_KEY))?.log).toHaveLength(2);
  });

  test("a finished game is never saved", () => {
    const solo: GameInput = { players: ["Ada"], rules: { targetScore: 1000 } };
    const log = buildLog(solo, [
      [{ type: "roll" }, [1, 1, 1, 2, 3, 4]],
      [{ type: "toggleDie", index: 0 }],
      [{ type: "toggleDie", index: 1 }],
      [{ type: "toggleDie", index: 2 }],
      [{ type: "bank" }],
    ]);
    expect(serializeGame({ input: solo, log })).toBeNull();
    const store = new MemoryStore();
    store.setItem(SAVE_KEY, "x");
    persistSession(createLocalSession({ input: solo, log }), store);
    expect(store.getItem(SAVE_KEY)).toBeNull();
  });

  test("survives storage that throws", () => {
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const session = createLocalSession({ input: INPUT });
    expect(() => persistSession(session, broken)).not.toThrow();
    expect(() => session.sendIntent({ type: "roll" })).not.toThrow();
    expect(loadSavedGame(broken)).toBeNull();
    expect(() => clearSavedGame(broken)).not.toThrow();
  });
});

describe("unusable saves are discarded", () => {
  const expectDiscarded = (data: unknown) => {
    const store = new MemoryStore();
    store.setItem(SAVE_KEY, typeof data === "string" ? data : JSON.stringify(data));
    expect(loadSavedGame(store)).toBeNull();
    expect(store.getItem(SAVE_KEY)).toBeNull();
  };

  test("the unmodified save loads (control)", () => {
    expect(parseSavedGame(JSON.stringify(goodSave()))).not.toBeNull();
  });

  test("corrupt JSON, wrong shapes, and version mismatch", () => {
    expectDiscarded("{oops");
    expectDiscarded("null");
    expectDiscarded([]);
    expectDiscarded({ ...goodSave(), version: 1 });
    expectDiscarded({ ...goodSave(), input: { players: [] } });
    expectDiscarded({ ...goodSave(), input: { players: Array(9).fill("x") } });
    expectDiscarded({ ...goodSave(), log: "nope" });
  });

  test("logs the machine would reject", () => {
    const save = goodSave();
    // Out of order.
    expectDiscarded({ ...save, log: [...save.log].reverse() });
    // A throw with the wrong number of dice.
    const badRoll = structuredClone(save);
    badRoll.log[1].event.values = [1, 2];
    expectDiscarded(badRoll);
    // A seat that doesn't exist.
    const badSeat = structuredClone(save);
    badSeat.log[0].seat = 7;
    expectDiscarded(badSeat);
    expect(isValidLog(INPUT, [{ seq: 0, seat: 0, event: { type: "bank" } }])).toBe(false);
  });
});

describe("setup preferences", () => {
  test("round-trip", () => {
    const store = new MemoryStore();
    const prefs = { players: ["Ada", "Bo", "Cy"], targetScore: 7500, entryThreshold: 500 };
    saveSetupPrefs(prefs, store);
    expect(loadSetupPrefs(store)).toEqual(prefs);
  });

  test("fall back to defaults for missing or bad data", () => {
    const store = new MemoryStore();
    expect(loadSetupPrefs(store)).toEqual(DEFAULT_PREFS);
    store.setItem(PREFS_KEY, "{oops");
    expect(loadSetupPrefs(store)).toEqual(DEFAULT_PREFS);
    store.setItem(PREFS_KEY, JSON.stringify({ players: [1, "", "  "], targetScore: -5, entryThreshold: "x" }));
    expect(loadSetupPrefs(store)).toEqual(DEFAULT_PREFS);
    // The returned default roster is a copy, safe to mutate.
    loadSetupPrefs(store).players.push("x");
    expect(DEFAULT_PREFS.players).toHaveLength(2);
  });

  test("clamps an oversized roster and long names", () => {
    const store = new MemoryStore();
    store.setItem(PREFS_KEY, JSON.stringify({ players: Array.from({ length: 12 }, (_, i) => `P${i} ${"x".repeat(40)}`) }));
    const prefs = loadSetupPrefs(store);
    expect(prefs.players).toHaveLength(8);
    expect(prefs.players.every((n) => n.length <= 16)).toBe(true);
  });
});
