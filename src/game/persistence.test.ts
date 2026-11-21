import { describe, expect, test } from "vitest";
import type { DieValue } from "./scoring";
import type { GameInput } from "./machine";
import {
  DEFAULT_PREFS,
  PREFS_KEY,
  SAVE_KEY,
  SAVE_VERSION,
  clearSavedGame,
  createGame,
  loadSavedGame,
  loadSetupPrefs,
  parseSavedGame,
  persistGame,
  restoreGame,
  saveSetupPrefs,
  serializeGame,
  summarizeSavedGame,
  type GameActor,
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

function startGame(input: GameInput = INPUT) {
  const actor = createGame(input).start();
  return { actor, roll: (...values: DieValue[]) => roll(actor, ...values) };
}

function roll(actor: GameActor, ...values: DieValue[]) {
  actor.send({ type: "roll" });
  actor.send({ type: "rolled", values });
}

/** Ada banks 1,000 (three 1s), then Bo rolls and selects a 5. */
function midGame() {
  const game = startGame();
  game.roll(1, 1, 1, 2, 3, 4);
  for (const index of [0, 1, 2]) game.actor.send({ type: "toggleDie", index });
  game.actor.send({ type: "bank" });
  game.roll(5, 2, 3, 4, 6, 6);
  game.actor.send({ type: "toggleDie", index: 0 });
  return game;
}

/** Reload the page: only the stored string survives. */
function reload(store: MemoryStore) {
  const saved = loadSavedGame(store);
  if (!saved) throw new Error("expected a saved game");
  const actor = restoreGame(saved);
  if (!actor) throw new Error("expected the save to restore");
  return { saved, actor: actor.start() };
}

describe("save and restore", () => {
  test("round-trips a game in progress through JSON", () => {
    const { actor } = midGame();
    const json = serializeGame(actor, INPUT, 1234);
    expect(typeof json).toBe("string");

    const saved = parseSavedGame(json);
    expect(saved).not.toBeNull();
    expect(saved!.version).toBe(SAVE_VERSION);
    expect(saved!.savedAt).toBe(1234);
    expect(saved!.input).toEqual(INPUT);

    const restored = restoreGame(saved!)!.start();
    expect(restored.getSnapshot().status).toBe("active");
    expect(restored.getSnapshot().value).toEqual(actor.getSnapshot().value);
    expect(restored.getSnapshot().context).toEqual(actor.getSnapshot().context);
  });

  test("a restored game keeps playing with the same rules", () => {
    const store = new MemoryStore();
    const { actor: original } = midGame();
    persistGame(original, INPUT, store);

    const { actor } = reload(store);
    expect(actor.getSnapshot().matches({ playing: "choosing" })).toBe(true);
    // Bo has 50 selected: below the 500 entry threshold, so banking is refused.
    actor.send({ type: "bank" });
    expect(actor.getSnapshot().matches({ playing: "choosing" })).toBe(true);
    actor.send({ type: "keepAndRoll" });
    expect(actor.getSnapshot().matches({ playing: "rolling" })).toBe(true);
    actor.send({ type: "rolled", values: [2, 3, 4, 6, 6] });
    expect(actor.getSnapshot().matches({ playing: "farkled" })).toBe(true);
    actor.send({ type: "passTurn" });
    expect(actor.getSnapshot().context.current).toBe(0);
    expect(actor.getSnapshot().context.players).toEqual([
      { name: "Ada", score: 1000 },
      { name: "Bo", score: 0 },
    ]);
  });

  test("restoring does not share objects with the parsed save", () => {
    const store = new MemoryStore();
    persistGame(midGame().actor, INPUT, store);
    const { saved, actor } = reload(store);
    const before = JSON.stringify(saved);
    actor.send({ type: "toggleDie", index: 0 });
    actor.send({ type: "toggleDie", index: 0 });
    expect(JSON.stringify(saved)).toBe(before);
    expect(restoreGame(saved)).not.toBeNull();
  });

  test("summarizes players and scores for the resume prompt", () => {
    const store = new MemoryStore();
    persistGame(midGame().actor, INPUT, store);
    expect(summarizeSavedGame(loadSavedGame(store)!)).toMatchObject({
      players: [
        { name: "Ada", score: 1000 },
        { name: "Bo", score: 0 },
      ],
      current: 1,
      targetScore: 5000,
      finalRound: false,
    });
  });
});

describe("persistGame", () => {
  test("saves immediately and after every change", () => {
    const store = new MemoryStore();
    const { actor, roll } = startGame();
    persistGame(actor, INPUT, store);
    expect(store.writes).toBe(1);
    expect(loadSavedGame(store)!.snapshot.value).toEqual({ playing: "awaitingRoll" });

    roll(1, 2, 3, 4, 6, 6);
    expect(loadSavedGame(store)!.snapshot.value).toEqual({ playing: "choosing" });
    actor.send({ type: "toggleDie", index: 0 });
    expect(loadSavedGame(store)!.snapshot.context.selected).toEqual([0]);
  });

  test("never writes a mid-roll state: the save stays on the last settled one", () => {
    const store = new MemoryStore();
    const { actor } = startGame();
    persistGame(actor, INPUT, store);

    actor.send({ type: "roll" });
    expect(actor.getSnapshot().matches({ playing: "rolling" })).toBe(true);
    expect(serializeGame(actor, INPUT)).toBeNull();
    expect(loadSavedGame(store)!.snapshot.value).toEqual({ playing: "awaitingRoll" });

    actor.send({ type: "rolled", values: [1, 5, 2, 3, 4, 6] });
    actor.send({ type: "toggleDie", index: 0 });
    actor.send({ type: "keepAndRoll" });
    expect(actor.getSnapshot().matches({ playing: "rolling" })).toBe(true);

    // Reload mid-throw: back in `choosing` with the 1 still selected and nothing banked yet.
    const { actor: resumed } = reload(store);
    expect(resumed.getSnapshot().matches({ playing: "choosing" })).toBe(true);
    expect(resumed.getSnapshot().context.selected).toEqual([0]);
    expect(resumed.getSnapshot().context.turnPoints).toBe(0);
    // ...and the throw can simply be made again.
    resumed.send({ type: "keepAndRoll" });
    resumed.send({ type: "rolled", values: [1, 1, 1, 2, 3] });
    expect(resumed.getSnapshot().matches({ playing: "choosing" })).toBe(true);
    expect(resumed.getSnapshot().context.turnPoints).toBe(100);
  });

  test("clears the save when the game finishes", () => {
    const store = new MemoryStore();
    const input: GameInput = { players: ["Solo"], rules: { targetScore: 1000 } };
    const { actor, roll } = startGame(input);
    persistGame(actor, input, store);
    roll(1, 1, 1, 2, 3, 4);
    for (const index of [0, 1, 2]) actor.send({ type: "toggleDie", index });
    expect(store.getItem(SAVE_KEY)).not.toBeNull();
    actor.send({ type: "bank" }); // reaches the target: final round
    roll(2, 2, 3, 4, 6, 6); // farkle on the last turn
    actor.send({ type: "passTurn" });
    expect(actor.getSnapshot().status).toBe("done");
    expect(store.getItem(SAVE_KEY)).toBeNull();
    expect(serializeGame(actor, input)).toBeNull();
  });

  test("stops saving after unsubscribe, and stopping the actor keeps the save", () => {
    const store = new MemoryStore();
    const { actor, roll } = startGame();
    const stop = persistGame(actor, INPUT, store);
    roll(1, 2, 3, 4, 6, 6);
    const stored = store.getItem(SAVE_KEY);
    actor.stop();
    expect(store.getItem(SAVE_KEY)).toBe(stored);
    stop();
    expect(serializeGame(actor, INPUT)).toBeNull();
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
    const { actor, roll } = startGame();
    expect(() => persistGame(actor, INPUT, broken)).not.toThrow();
    expect(() => roll(1, 2, 3, 4, 6, 6)).not.toThrow();
    expect(loadSavedGame(broken)).toBeNull();
    expect(() => clearSavedGame(broken)).not.toThrow();
    expect(loadSetupPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(loadSavedGame(null)).toBeNull();
  });
});

describe("unusable saves are discarded", () => {
  const goodSave = () => JSON.parse(serializeGame(midGame().actor, INPUT)!);
  const stored = (value: unknown) => {
    const store = new MemoryStore();
    store.setItem(SAVE_KEY, typeof value === "string" ? value : JSON.stringify(value));
    return store;
  };
  const expectDiscarded = (value: unknown) => {
    const store = stored(value);
    expect(loadSavedGame(store)).toBeNull();
    expect(store.getItem(SAVE_KEY)).toBeNull();
  };

  test("the unmodified save loads (control)", () => {
    expect(loadSavedGame(stored(goodSave()))).not.toBeNull();
  });

  test("nothing stored", () => {
    expect(loadSavedGame(new MemoryStore())).toBeNull();
    expect(parseSavedGame(null)).toBeNull();
    expect(parseSavedGame("")).toBeNull();
  });

  test("corrupt JSON and wrong shapes", () => {
    const json = JSON.stringify(goodSave());
    expectDiscarded(json.slice(0, json.length / 2));
    expectDiscarded("not json");
    expectDiscarded("null");
    expectDiscarded("42");
    expectDiscarded([]);
    expectDiscarded({});
    expectDiscarded({ version: SAVE_VERSION });
    expectDiscarded({ ...goodSave(), snapshot: "nope" });
    expectDiscarded({ ...goodSave(), input: { players: [] } });
    expectDiscarded({ ...goodSave(), input: undefined });
  });

  test("version mismatch", () => {
    expectDiscarded({ ...goodSave(), version: SAVE_VERSION + 1 });
    expectDiscarded({ ...goodSave(), version: SAVE_VERSION - 1 });
    expectDiscarded({ ...goodSave(), version: String(SAVE_VERSION) });
    const { version: _version, ...unversioned } = goodSave();
    expectDiscarded(unversioned);
  });

  test("states that cannot be resumed", () => {
    const withSnapshot = (patch: object) => {
      const save = goodSave();
      return { ...save, snapshot: { ...save.snapshot, ...patch } };
    };
    expectDiscarded(withSnapshot({ value: { playing: "rolling" } }));
    expectDiscarded(withSnapshot({ value: { playing: "shuffling" } }));
    expectDiscarded(withSnapshot({ value: "gameOver" }));
    expectDiscarded(withSnapshot({ value: undefined }));
    expectDiscarded(withSnapshot({ status: "done" }));
    expectDiscarded(withSnapshot({ status: "error" }));
    expectDiscarded(withSnapshot({ status: "stopped" }));
  });

  test("impossible context", () => {
    const withContext = (patch: object) => {
      const save = goodSave();
      return { ...save, snapshot: { ...save.snapshot, context: { ...save.snapshot.context, ...patch } } };
    };
    expectDiscarded(withContext({ players: [] }));
    expectDiscarded(withContext({ players: [{ name: "Ada", score: "lots" }, { name: "Bo", score: 0 }] }));
    expectDiscarded(withContext({ players: [{ name: "Ada", score: 0 }] })); // doesn't match input
    expectDiscarded(withContext({ current: 2 }));
    expectDiscarded(withContext({ current: -1 }));
    expectDiscarded(withContext({ turnPoints: null }));
    expectDiscarded(withContext({ dice: [] }));
    expectDiscarded(withContext({ dice: Array.from({ length: 6 }, () => ({ value: 7, held: false })) }));
    expectDiscarded(withContext({ selected: [9] }));
    expectDiscarded(withContext({ finalRoundBy: 5 }));
    expectDiscarded(withContext({ rules: undefined }));
    expectDiscarded(withContext({ rules: { targetScore: 5000, entryThreshold: 0 } }));
    const save = goodSave();
    expectDiscarded({ ...save, snapshot: { ...save.snapshot, context: undefined } });
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
