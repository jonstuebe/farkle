import { afterEach, describe, expect, test, vi } from "vitest";
import { initialTransition, transition } from "xstate";
import { botIntent, botNames, driveBots, planChoice, scoringPicks } from "./bot";
import { applyIntent, replayLog, type GameSnapshot, type LogEntry } from "./log";
import { DEFAULT_RULES, farkleMachine, type GameContext, type GameInput } from "./machine";
import { Presenter } from "./presenter";
import { createLocalSession } from "./session";
import type { DieValue } from "./scoring";

/** A game in `choosing` after the current player threw `values` (with `turnPoints` already kept). */
function afterRoll(values: DieValue[], patch: Partial<GameContext> = {}): GameSnapshot {
  let [snapshot] = initialTransition(farkleMachine, { players: ["You", "Ada"] });
  snapshot = { ...snapshot, context: { ...snapshot.context, ...patch } } as GameSnapshot;
  [snapshot] = transition(farkleMachine, snapshot, { type: "roll" });
  const free = snapshot.context.dice.filter((d) => !d.held).length;
  [snapshot] = transition(farkleMachine, snapshot, { type: "rolled", values: values.slice(0, free) });
  return snapshot;
}

const valuesOf = (ctx: GameContext, dice: number[]) => dice.map((i) => ctx.dice[i]!.value);

describe("botNames", () => {
  test("gives distinct names and avoids the person's", () => {
    expect(botNames(3, ["ada"])).toEqual(["Basil", "Clover", "Dash"]);
    expect(new Set(botNames(7)).size).toBe(7);
  });
});

describe("planChoice", () => {
  test("lists only scoring picks", () => {
    const { context } = afterRoll([1, 2, 3, 4, 6, 6]);
    expect(scoringPicks(context).map((p) => p.points)).toEqual([100]);
  });

  test("keeps a lone 1 but leaves extra 5s to throw more dice", () => {
    const { context } = afterRoll([1, 5, 2, 3, 4, 6]);
    // A straight: take it all.
    expect(planChoice(context)).toEqual({ dice: [0, 1, 2, 3, 4, 5], action: "keepAndRoll" });

    const second = afterRoll([1, 5, 2, 2, 3, 6]).context;
    const plan = planChoice(second)!;
    expect(valuesOf(second, plan.dice)).toEqual([1]);
    expect(plan.action).toBe("keepAndRoll");
  });

  test("banks a good total when few dice are left", () => {
    // 600 kept earlier, two dice to throw: the 1 scores, banking 700.
    const held = { value: 3 as DieValue, held: true, keep: 0 };
    const snapshot = afterRoll([1, 2], {
      turnPoints: 600,
      dice: [held, held, held, held, { value: null, held: false, keep: null }, { value: null, held: false, keep: null }],
    });
    expect(planChoice(snapshot.context)).toEqual({ dice: [4], action: "bank" });
  });

  test("keeps everything and rolls on when that gives hot dice", () => {
    const held = { value: 3 as DieValue, held: true, keep: 0 };
    const snapshot = afterRoll([1, 5], {
      turnPoints: 600,
      dice: [held, held, held, held, { value: null, held: false, keep: null }, { value: null, held: false, keep: null }],
    });
    expect(planChoice(snapshot.context)).toEqual({ dice: [4, 5], action: "keepAndRoll" });
  });

  test("never banks below the entry threshold", () => {
    const held = { value: 3 as DieValue, held: true, keep: 0 };
    const snapshot = afterRoll([1, 2], {
      turnPoints: 300,
      rules: { ...DEFAULT_RULES, entryThreshold: 500 },
      dice: [held, held, held, held, { value: null, held: false, keep: null }, { value: null, held: false, keep: null }],
    });
    expect(planChoice(snapshot.context)?.action).toBe("keepAndRoll");
  });

  test("in the final round, keeps rolling until it takes the lead", () => {
    const held = { value: 3 as DieValue, held: true, keep: 0 };
    const dice = [held, held, held, held, { value: null, held: false, keep: null }, { value: null, held: false, keep: null }];
    const behind = afterRoll([1, 2], {
      turnPoints: 2000,
      finalRoundBy: 0,
      current: 1,
      players: [
        { name: "You", score: 10_500 },
        { name: "Ada", score: 8000 },
      ],
      dice,
    });
    expect(planChoice(behind.context)?.action).toBe("keepAndRoll");

    const ahead = afterRoll([1, 2], {
      turnPoints: 2500,
      finalRoundBy: 0,
      current: 1,
      players: [
        { name: "You", score: 10_500 },
        { name: "Ada", score: 8000 },
      ],
      dice,
    });
    expect(planChoice(ahead.context)?.action).toBe("bank");
  });
});

describe("botIntent", () => {
  test("rolls, picks dice one at a time, then acts", () => {
    let [snapshot] = initialTransition(farkleMachine, { players: ["You", "Ada"] });
    expect(botIntent(snapshot)).toEqual({ type: "roll" });
    snapshot = afterRoll([1, 1, 1, 2, 3, 4]);
    expect(botIntent(snapshot)).toEqual({ type: "toggleDie", index: 0 });
    [snapshot] = transition(farkleMachine, snapshot, { type: "toggleDie", index: 0 });
    expect(botIntent(snapshot)).toEqual({ type: "toggleDie", index: 1 });
  });

  test("drops a die it should not keep", () => {
    let snapshot = afterRoll([1, 5, 2, 2, 3, 6]);
    [snapshot] = transition(farkleMachine, snapshot, { type: "toggleDie", index: 1 });
    expect(botIntent(snapshot)).toEqual({ type: "toggleDie", index: 0 });
  });

  test("passes the dice after a farkle", () => {
    expect(botIntent(afterRoll([2, 2, 3, 3, 4, 6]))).toEqual({ type: "passTurn" });
  });
});

describe("bots playing whole games", () => {
  /** Deterministic dice so the test is repeatable. */
  function seededDie(seed: number) {
    let s = seed;
    return (): DieValue => {
      s = (s * 1_103_515_245 + 12_345) % 2 ** 31;
      return ((s % 6) + 1) as DieValue;
    };
  }

  test.each([1, 2, 3, 4, 5])("an all-bot game finishes (seed %i)", (seed) => {
    const input: GameInput = { players: ["Ada", "Basil", "Clover"], bots: [0, 1, 2], rules: { entryThreshold: 500 } };
    const die = seededDie(seed);
    const log: LogEntry[] = [];
    let snapshot = replayLog(input, log);
    for (let moves = 0; snapshot.status === "active"; moves++) {
      expect(moves).toBeLessThan(20_000);
      const intent = botIntent(snapshot);
      expect(intent).not.toBeNull();
      const result = applyIntent(snapshot, log.length, snapshot.context.current, intent!, die);
      expect(result.ok).toBe(true);
      if (result.ok) log.push(...result.entries);
      snapshot = replayLog(input, log);
    }
    expect(Math.max(...snapshot.context.players.map((p) => p.score))).toBeGreaterThanOrEqual(10_000);
  });
});

describe("driveBots", () => {
  let stop: (() => void) | undefined;
  let presenter: Presenter | undefined;
  afterEach(() => {
    stop?.();
    presenter?.stop();
    vi.useRealTimers();
  });

  test("plays the bot's turn at the presenter's pace and leaves the person's turn alone", () => {
    vi.useFakeTimers();
    const session = createLocalSession({ input: { players: ["You", "Ada"], bots: [1] } });
    expect(session.getState().mySeats).toEqual([0]);
    presenter = new Presenter(session, { pacing: 0 });
    stop = driveBots(session, presenter, { pacing: 0 });

    // The person's turn: nothing happens.
    vi.advanceTimersByTime(5000);
    expect(session.getState().log).toHaveLength(0);

    // Hand the dice to the bot by farkling or banking as the person.
    while (presenter.actor.getSnapshot().context.current === 0) {
      const intent = botIntent(presenter.actor.getSnapshot())!;
      session.sendIntent(intent);
      const pending = presenter.getView().pendingThrow;
      if (pending) presenter.throwSettled(pending.seq);
    }

    // The bot rolls, but waits for each throw to be animated.
    const before = session.getState().log.length;
    vi.advanceTimersByTime(0);
    expect(session.getState().log.length).toBe(before + 2);
    const pending = presenter.getView().pendingThrow!;
    vi.advanceTimersByTime(5000);
    expect(session.getState().log.length).toBe(before + 2);

    // Settling every throw lets the bot finish its turn and hand back to the person.
    presenter.throwSettled(pending.seq);
    for (let i = 0; i < 500 && presenter.actor.getSnapshot().context.current === 1; i++) {
      vi.advanceTimersByTime(1);
      const next = presenter.getView().pendingThrow;
      if (next) presenter.throwSettled(next.seq);
    }
    expect(presenter.actor.getSnapshot().context.current).toBe(0);
    expect(session.getState().log.every((e) => e.seat === 0 || e.seat === 1)).toBe(true);
  });
});
