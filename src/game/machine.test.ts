import { describe, expect, test } from "vitest";
import { createActor } from "xstate";
import { canBank, farkleMachine, pendingTurnTotal, type GameInput } from "./machine";
import type { DieValue } from "./scoring";

function startGame(input: GameInput = { players: ["Ada", "Bo"] }) {
  const actor = createActor(farkleMachine, { input }).start();
  const snap = () => actor.getSnapshot();
  const ctx = () => snap().context;
  const roll = (...values: DieValue[]) => {
    actor.send({ type: "roll" });
    actor.send({ type: "rolled", values });
  };
  const select = (...indices: number[]) => indices.forEach((index) => actor.send({ type: "toggleDie", index }));
  return { actor, snap, ctx, roll, select };
}

describe("farkleMachine", () => {
  test("starts waiting for the first player to roll", () => {
    const { snap, ctx } = startGame();
    expect(snap().matches({ playing: "awaitingRoll" })).toBe(true);
    expect(ctx().players).toEqual([
      { name: "Ada", score: 0 },
      { name: "Bo", score: 0 },
    ]);
    expect(ctx().current).toBe(0);
  });

  test("a scoring roll lets the player choose dice", () => {
    const { snap, ctx, roll } = startGame();
    roll(1, 2, 3, 4, 6, 6);
    expect(snap().matches({ playing: "choosing" })).toBe(true);
    expect(ctx().dice.map((d) => d.value)).toEqual([1, 2, 3, 4, 6, 6]);
  });

  test("ignores a rolled event with the wrong number of dice", () => {
    const { actor, snap } = startGame();
    actor.send({ type: "roll" });
    actor.send({ type: "rolled", values: [1, 2, 3] });
    expect(snap().matches({ playing: "rolling" })).toBe(true);
  });

  test("keeps record each set aside separately: three 5s over three rolls are 150, not 500", () => {
    const { actor, ctx, roll, select } = startGame();
    roll(5, 2, 3, 4, 6, 6);
    select(0);
    actor.send({ type: "keepAndRoll" });
    actor.send({ type: "rolled", values: [5, 2, 3, 4, 6] });
    select(1);
    actor.send({ type: "keepAndRoll" });
    expect(ctx().keeps).toEqual([
      { dice: [0], values: [5], points: 50, hotDice: false },
      { dice: [1], values: [5], points: 50, hotDice: false },
    ]);
    expect(ctx().dice.map((d) => d.keep)).toEqual([0, 1, null, null, null, null]);
    expect(ctx().turnPoints).toBe(100);
  });

  test("keeps survive hot dice and clear when the turn ends", () => {
    const { actor, ctx, roll, select } = startGame();
    roll(1, 1, 1, 5, 5, 5);
    select(0, 1, 2, 3, 4, 5);
    actor.send({ type: "keepAndRoll" });
    expect(ctx().keeps).toEqual([{ dice: [0, 1, 2, 3, 4, 5], values: [1, 1, 1, 5, 5, 5], points: 2500, hotDice: true }]);
    expect(ctx().dice.every((d) => !d.held && d.keep === null)).toBe(true);
    actor.send({ type: "rolled", values: [1, 2, 3, 4, 6, 6] });
    select(0);
    actor.send({ type: "bank" });
    expect(ctx().keeps).toEqual([]);
    expect(ctx().players[0]!.score).toBe(2600);
  });

  test("a farkle scores nothing and passes the dice", () => {
    const { actor, snap, ctx, roll, select } = startGame();
    roll(1, 2, 3, 4, 6, 6);
    select(0);
    actor.send({ type: "keepAndRoll" });
    actor.send({ type: "rolled", values: [2, 3, 4, 6, 6] });
    expect(snap().matches({ playing: "farkled" })).toBe(true);

    actor.send({ type: "passTurn" });
    expect(snap().matches({ playing: "awaitingRoll" })).toBe(true);
    expect(ctx().players[0]!.score).toBe(0);
    expect(ctx().current).toBe(1);
    expect(ctx().turnPoints).toBe(0);
  });

  test("only free dice can be selected, and only scoring selections are accepted", () => {
    const { actor, snap, ctx, roll, select } = startGame();
    roll(1, 2, 3, 4, 6, 6);

    select(1); // a lone 2 doesn't score
    actor.send({ type: "keepAndRoll" });
    actor.send({ type: "bank" });
    expect(snap().matches({ playing: "choosing" })).toBe(true);

    select(1); // deselect
    select(0);
    expect(ctx().selected).toEqual([0]);
    actor.send({ type: "keepAndRoll" });
    actor.send({ type: "rolled", values: [5, 3, 4, 6, 2] });
    expect(ctx().turnPoints).toBe(100);

    select(0); // held from the previous roll
    expect(ctx().selected).toEqual([]);
  });

  test("keeping dice accumulates turn points and rolls only the rest", () => {
    const { actor, ctx, roll, select } = startGame();
    roll(1, 5, 3, 4, 6, 2);
    select(0, 1);
    actor.send({ type: "keepAndRoll" });
    expect(ctx().turnPoints).toBe(150);
    expect(ctx().dice.filter((d) => d.held)).toHaveLength(2);

    actor.send({ type: "rolled", values: [2, 2, 2, 3] });
    select(2, 3, 4);
    expect(pendingTurnTotal(ctx())).toBe(350);
    actor.send({ type: "bank" });
    expect(ctx().players[0]!.score).toBe(350);
    expect(ctx().current).toBe(1);
    expect(ctx().dice.every((d) => !d.held && d.value === null)).toBe(true);
  });

  test("hot dice: scoring all six gives the player every die back", () => {
    const { actor, snap, ctx, roll, select } = startGame();
    roll(1, 1, 1, 2, 3, 4);
    select(0, 1, 2);
    actor.send({ type: "keepAndRoll" });
    actor.send({ type: "rolled", values: [5, 5, 5] });
    select(3, 4, 5);
    actor.send({ type: "keepAndRoll" });

    expect(snap().matches({ playing: "rolling" })).toBe(true);
    expect(ctx().turnPoints).toBe(1500);
    expect(ctx().dice.every((d) => !d.held)).toBe(true);

    actor.send({ type: "rolled", values: [2, 3, 4, 6, 6, 3] });
    expect(snap().matches({ playing: "farkled" })).toBe(true);
  });

  test("the entry threshold blocks banking small first turns", () => {
    const { actor, ctx, roll, select } = startGame({ players: ["Ada"], rules: { entryThreshold: 500 } });
    roll(1, 5, 3, 4, 6, 2);
    select(0, 1);
    expect(canBank(ctx())).toBe(false);
    actor.send({ type: "bank" });
    expect(ctx().players[0]!.score).toBe(0);

    actor.send({ type: "keepAndRoll" });
    actor.send({ type: "rolled", values: [1, 1, 1, 3] });
    select(2, 3, 4);
    expect(canBank(ctx())).toBe(true);
    actor.send({ type: "bank" });
    expect(ctx().players[0]!.score).toBe(1150);
  });

  test("reaching the target gives everyone else one last turn", () => {
    const { actor, snap, ctx, roll, select } = startGame({
      players: ["Ada", "Bo", "Cy"],
      rules: { targetScore: 1000 },
    });

    roll(1, 1, 1, 2, 3, 4);
    select(0, 1, 2);
    actor.send({ type: "bank" });
    expect(ctx().finalRoundBy).toBe(0);
    expect(snap().matches("playing")).toBe(true);

    // Bo out-scores Ada on the final round.
    roll(6, 6, 6, 6, 6, 1);
    select(0, 1, 2, 3, 4, 5);
    actor.send({ type: "bank" });
    expect(snap().matches("playing")).toBe(true);

    // Cy farkles; the turn would return to Ada, so the game ends.
    roll(2, 3, 4, 6, 6, 3);
    actor.send({ type: "passTurn" });

    expect(snap().status).toBe("done");
    expect(snap().output).toEqual({
      winners: [1],
      players: [
        { name: "Ada", score: 1000 },
        { name: "Bo", score: 2100 },
        { name: "Cy", score: 0 },
      ],
    });
  });

  test("a solo game ends as soon as the target is banked", () => {
    const { actor, snap, roll, select } = startGame({ players: ["Ada"], rules: { targetScore: 1000 } });
    roll(1, 1, 1, 2, 3, 4);
    select(0, 1, 2);
    actor.send({ type: "bank" });
    expect(snap().status).toBe("done");
    expect(snap().output?.winners).toEqual([0]);
  });

  test("rejects a game with no players", () => {
    const actor = createActor(farkleMachine, { input: { players: [] } });
    const errors: unknown[] = [];
    actor.subscribe({ error: (err) => errors.push(err) });
    actor.start();
    expect(actor.getSnapshot().status).toBe("error");
    expect(String(errors[0])).toContain("at least one player");
  });
});
