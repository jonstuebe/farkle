import { describe, expect, test } from "vitest";
import { applyIntent, replayLog, secureRandomDie, type Intent, type LogEntry } from "./log";
import type { GameInput } from "./machine";
import type { DieValue } from "./scoring";

const input: GameInput = { players: ["Ada", "Bo"] };

/** Feeds a fixed sequence of die values. */
const dice = (...values: DieValue[]) => {
  let i = 0;
  return () => {
    const v = values[i++];
    if (v === undefined) throw new Error("ran out of scripted dice");
    return v;
  };
};

function play(steps: Array<[seat: number, intent: Intent, values?: DieValue[]]>) {
  const log: LogEntry[] = [];
  for (const [seat, intent, values = []] of steps) {
    const result = applyIntent(replayLog(input, log), log.length, seat, intent, dice(...values));
    if (!result.ok) throw new Error(`rejected ${intent.type}: ${result.reason}`);
    log.push(...result.entries);
  }
  return log;
}

describe("applyIntent", () => {
  test("a roll becomes roll + rolled with one value per free die", () => {
    const log = play([[0, { type: "roll" }, [1, 2, 3, 4, 6, 6]]]);
    expect(log).toEqual([
      { seq: 0, seat: 0, event: { type: "roll" } },
      { seq: 1, seat: 0, event: { type: "rolled", values: [1, 2, 3, 4, 6, 6] } },
    ]);
    expect(replayLog(input, log).matches({ playing: "choosing" })).toBe(true);
  });

  test("keep & roll throws only the remaining dice, and all six on hot dice", () => {
    const log = play([
      [0, { type: "roll" }, [1, 1, 1, 2, 3, 4]],
      [0, { type: "toggleDie", index: 0 }],
      [0, { type: "toggleDie", index: 1 }],
      [0, { type: "toggleDie", index: 2 }],
      [0, { type: "keepAndRoll" }, [5, 5, 5]],
      [0, { type: "toggleDie", index: 3 }],
      [0, { type: "toggleDie", index: 4 }],
      [0, { type: "toggleDie", index: 5 }],
      [0, { type: "keepAndRoll" }, [2, 3, 4, 6, 6, 3]],
    ]);
    const rolls = log.filter((e) => e.event.type === "rolled").map((e) => (e.event as { values: DieValue[] }).values);
    expect(rolls.map((v) => v.length)).toEqual([6, 3, 6]);
    expect(replayLog(input, log).matches({ playing: "farkled" })).toBe(true);
  });

  test("rejects intents from the wrong seat, invalid moves, and moves after the game", () => {
    const fresh = replayLog(input, []);
    expect(applyIntent(fresh, 0, 1, { type: "roll" })).toEqual({ ok: false, reason: "notYourTurn" });
    expect(applyIntent(fresh, 0, 0, { type: "bank" })).toEqual({ ok: false, reason: "notAllowed" });

    const solo: GameInput = { players: ["Ada"], rules: { targetScore: 1000 } };
    const log: LogEntry[] = [];
    for (const [intent, values] of [
      [{ type: "roll" }, [1, 1, 1, 2, 3, 4]],
      [{ type: "toggleDie", index: 0 }, []],
      [{ type: "toggleDie", index: 1 }, []],
      [{ type: "toggleDie", index: 2 }, []],
      [{ type: "bank" }, []],
    ] as Array<[Intent, DieValue[]]>) {
      const r = applyIntent(replayLog(solo, log), log.length, 0, intent, dice(...values));
      if (!r.ok) throw new Error(r.reason);
      log.push(...r.entries);
    }
    expect(replayLog(solo, log).status).toBe("done");
    expect(applyIntent(replayLog(solo, log), log.length, 0, { type: "roll" })).toEqual({ ok: false, reason: "gameOver" });
  });

  test("replaying a log reproduces the same state", () => {
    const log = play([
      [0, { type: "roll" }, [1, 5, 3, 4, 6, 2]],
      [0, { type: "toggleDie", index: 0 }],
      [0, { type: "bank" }],
    ]);
    const roundTripped: LogEntry[] = JSON.parse(JSON.stringify(log));
    const snapshot = replayLog(input, roundTripped);
    expect(snapshot.context.players[0]!.score).toBe(100);
    expect(snapshot.context.current).toBe(1);
  });
});

test("secureRandomDie is roughly uniform over 1..6", () => {
  const counts = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 60_000; i++) counts[secureRandomDie()]!++;
  expect(counts[0]).toBe(0);
  for (let face = 1; face <= 6; face++) expect(counts[face]).toBeGreaterThan(9_000);
});
