import { describe, expect, test } from "vitest";
import { createActor } from "xstate";
import { farkleMachine, type GameInput } from "../../game/machine";
import { DEFAULT_SCORING, type DieValue } from "../../game/scoring";
import {
  actionsFor,
  diffFeedback,
  finalRoundInfo,
  finalRoundText,
  joinNames,
  needsEntry,
  rankPlayers,
  scoringRows,
  turnHint,
  viewOf,
  winnerHeadline,
  type Feedback,
} from "./logic";

/** A game whose every transition is recorded as HUD feedback. */
function startGame(input: GameInput = { players: ["Ada", "Bo"] }) {
  const actor = createActor(farkleMachine, { input }).start();
  const view = () => viewOf(actor.getSnapshot());
  let last: Feedback = { banners: [], sounds: [] };
  const send = (event: Parameters<typeof actor.send>[0]) => {
    const prev = view();
    actor.send(event);
    last = diffFeedback(prev, view());
    return last;
  };
  const roll = (...values: DieValue[]) => {
    send({ type: view().phase === "awaitingRoll" ? "roll" : "keepAndRoll" });
    return send({ type: "rolled", values });
  };
  const select = (...indices: number[]) => {
    for (const index of indices) send({ type: "toggleDie", index });
  };
  return { actor, view, send, roll, select };
}

const texts = (f: Feedback) => f.banners.map((b) => b.text);

describe("diffFeedback", () => {
  test("ordinary changes announce nothing", () => {
    const g = startGame();
    expect(g.send({ type: "roll" })).toEqual({ banners: [], sounds: [] });
    expect(g.send({ type: "rolled", values: [1, 2, 3, 4, 6, 6] })).toEqual({ banners: [], sounds: [] });
    expect(g.send({ type: "toggleDie", index: 0 })).toEqual({ banners: [], sounds: [] });
    expect(g.send({ type: "keepAndRoll" })).toEqual({ banners: [], sounds: [] });
  });

  test("farkle", () => {
    const g = startGame();
    const f = g.roll(2, 3, 4, 6, 6, 2);
    expect(g.view().phase).toBe("farkled");
    expect(f).toEqual({ banners: [{ kind: "farkle", text: "Farkle!" }], sounds: ["farkle"] });
    // Passing the dice is silent.
    expect(g.send({ type: "passTurn" })).toEqual({ banners: [], sounds: [] });
  });

  test("hot dice when the selection uses every free die", () => {
    const g = startGame();
    g.roll(1, 1, 1, 5, 5, 5);
    g.select(0, 1, 2, 3, 4, 5);
    const f = g.send({ type: "keepAndRoll" });
    expect(f).toEqual({ banners: [{ kind: "hotDice", text: "Hot dice!" }], sounds: ["hotDice"] });
  });

  test("hot dice across two throws", () => {
    const g = startGame();
    g.roll(1, 1, 1, 2, 3, 5);
    g.select(0, 1, 2);
    expect(g.send({ type: "keepAndRoll" }).banners).toEqual([]);
    g.send({ type: "rolled", values: [5, 5, 5] });
    g.select(3, 4, 5);
    expect(texts(g.send({ type: "keepAndRoll" }))).toEqual(["Hot dice!"]);
  });

  test("banking names the player and the amount", () => {
    const g = startGame();
    g.roll(1, 1, 1, 2, 3, 5);
    g.select(0, 1, 2, 5);
    const f = g.send({ type: "bank" });
    expect(f).toEqual({ banners: [{ kind: "banked", text: "Ada banked 1,050" }], sounds: ["bank"] });
  });

  test("reaching the target announces the final round", () => {
    const g = startGame({ players: ["Ada", "Bo"], rules: { targetScore: 1000 } });
    g.roll(1, 1, 1, 2, 3, 4);
    g.select(0, 1, 2);
    const f = g.send({ type: "bank" });
    expect(texts(f)).toEqual(["Ada banked 1,000", "Ada reached 1,000 — final round!"]);
    expect(f.sounds).toEqual(["bank"]);
  });

  test("the game-ending bank plays the win sound, not the bank sound", () => {
    const g = startGame({ players: ["Ada", "Bo"], rules: { targetScore: 1000 } });
    g.roll(1, 1, 1, 2, 3, 4);
    g.select(0, 1, 2);
    g.send({ type: "bank" });
    g.roll(1, 2, 3, 4, 6, 6);
    g.select(0);
    const f = g.send({ type: "bank" });
    expect(g.view().phase).toBe("done");
    expect(texts(f)).toEqual(["Bo banked 100"]);
    expect(f.sounds).toEqual(["win"]);
  });

  test("a farkle that ends the game plays the win sound when the dice are passed", () => {
    const g = startGame({ players: ["Ada", "Bo"], rules: { targetScore: 1000 } });
    g.roll(1, 1, 1, 2, 3, 4);
    g.select(0, 1, 2);
    g.send({ type: "bank" });
    g.roll(2, 3, 4, 6, 6, 2);
    expect(g.send({ type: "passTurn" })).toEqual({ banners: [], sounds: ["win"] });
  });

  test("a solo game ends on the bank that reaches the target without a final round", () => {
    const g = startGame({ players: ["Ada"], rules: { targetScore: 1000 } });
    g.roll(1, 1, 1, 2, 3, 4);
    g.select(0, 1, 2);
    const f = g.send({ type: "bank" });
    expect(texts(f)).toEqual(["Ada banked 1,000"]);
    expect(f.sounds).toEqual(["win"]);
  });
});

describe("finalRoundInfo", () => {
  test("null until someone reaches the target", () => {
    expect(finalRoundInfo(startGame().view().context)).toBeNull();
  });

  test("lists who still gets a turn, in play order", () => {
    const g = startGame({ players: ["Ada", "Bo", "Cy", "Di"], rules: { targetScore: 1000 } });
    g.roll(2, 3, 4, 6, 6, 2);
    g.send({ type: "passTurn" });
    // Bo triggers the final round.
    g.roll(1, 1, 1, 2, 3, 4);
    g.select(0, 1, 2);
    g.send({ type: "bank" });
    expect(finalRoundInfo(g.view().context)).toEqual({ by: "Bo", remaining: ["Cy", "Di", "Ada"] });
    g.roll(2, 3, 4, 6, 6, 2);
    g.send({ type: "passTurn" });
    expect(finalRoundInfo(g.view().context)).toEqual({ by: "Bo", remaining: ["Di", "Ada"] });
  });
});

describe("finalRoundText", () => {
  test("names the players left, or counts them when there are many", () => {
    expect(finalRoundText({ by: "Bo", remaining: ["Cy"] })).toBe("Bo reached the target. Cy has the last turn.");
    expect(finalRoundText({ by: "Bo", remaining: ["Cy", "Di", "Ada"] })).toBe(
      "Bo reached the target. Still to roll: Cy, Di and Ada.",
    );
    expect(finalRoundText({ by: "Bo", remaining: ["Cy", "Di", "Ed", "Ada"] })).toBe(
      "Bo reached the target. 4 players still to roll, Cy first.",
    );
  });
});

describe("rankPlayers", () => {
  test("sorts by score, highest first", () => {
    const ranked = rankPlayers([
      { name: "Ada", score: 300 },
      { name: "Bo", score: 900 },
      { name: "Cy", score: 500 },
    ]);
    expect(ranked.map((p) => [p.rank, p.name, p.index])).toEqual([
      [1, "Bo", 1],
      [2, "Cy", 2],
      [3, "Ada", 0],
    ]);
  });

  test("tied players share a rank and keep seating order", () => {
    const ranked = rankPlayers([
      { name: "Ada", score: 500 },
      { name: "Bo", score: 900 },
      { name: "Cy", score: 900 },
      { name: "Di", score: 500 },
      { name: "Ed", score: 100 },
    ]);
    expect(ranked.map((p) => [p.rank, p.name])).toEqual([
      [1, "Bo"],
      [1, "Cy"],
      [3, "Ada"],
      [3, "Di"],
      [5, "Ed"],
    ]);
  });

  test("does not mutate its input", () => {
    const players = [
      { name: "Ada", score: 1 },
      { name: "Bo", score: 2 },
    ];
    rankPlayers(players);
    expect(players.map((p) => p.name)).toEqual(["Ada", "Bo"]);
  });
});

describe("winnerHeadline", () => {
  const players = [
    { name: "Ada", score: 0 },
    { name: "Bo", score: 0 },
    { name: "Cy", score: 0 },
  ];
  test("one winner", () => expect(winnerHeadline(players, [1])).toBe("Bo wins!"));
  test("two-way tie", () => expect(winnerHeadline(players, [0, 2])).toBe("Ada and Cy tie!"));
  test("three-way tie", () => expect(winnerHeadline(players, [0, 1, 2])).toBe("Ada, Bo and Cy tie!"));
  test("joinNames", () => {
    expect(joinNames([])).toBe("");
    expect(joinNames(["Ada"])).toBe("Ada");
  });
});

describe("actionsFor", () => {
  test("awaiting roll, rolling and farkled", () => {
    const g = startGame();
    expect(actionsFor(g.view())).toEqual({ primary: { label: "Roll", enabled: true, event: "roll" }, bank: null });
    g.send({ type: "roll" });
    expect(actionsFor(g.view())).toEqual({
      primary: { label: "Rolling…", enabled: false, event: null },
      bank: null,
    });
    g.send({ type: "rolled", values: [2, 3, 4, 6, 6, 2] });
    expect(actionsFor(g.view())).toEqual({
      primary: { label: "Pass dice", enabled: true, event: "passTurn" },
      bank: null,
    });
  });

  test("choosing: nothing selected, an invalid pick, then a valid one", () => {
    const g = startGame();
    g.roll(1, 2, 3, 4, 6, 5);
    let a = actionsFor(g.view());
    expect(a.primary).toMatchObject({ label: "Keep & roll", enabled: false });
    expect(a.bank).toMatchObject({ label: "Bank", enabled: false });

    g.select(1);
    a = actionsFor(g.view());
    expect(a.primary.enabled).toBe(false);
    expect(a.bank?.enabled).toBe(false);

    g.select(1, 0);
    a = actionsFor(g.view());
    expect(a.primary).toMatchObject({ label: "Keep & roll 5 dice", enabled: true, event: "keepAndRoll" });
    expect(a.bank).toEqual({ label: "Bank 100", enabled: true, event: "bank" });
  });

  test("singular die, turn total in the bank label, and hot dice", () => {
    const g = startGame();
    g.roll(1, 1, 1, 2, 5, 5);
    g.select(0, 1, 2, 4);
    expect(actionsFor(g.view()).primary.label).toBe("Keep & roll 2 dice");
    g.roll(5, 6);
    g.select(3);
    let a = actionsFor(g.view());
    expect(a.primary.label).toBe("Keep & roll 1 die");
    expect(a.bank?.label).toBe("Bank 1,100");
    g.roll(1);
    g.select(5);
    a = actionsFor(g.view());
    expect(a.primary).toMatchObject({ label: "Hot dice! Roll all 6", enabled: true, hotDice: true });
    expect(a.bank?.label).toBe("Bank 1,200");
  });

  test("the entry threshold disables banking until it is met", () => {
    const g = startGame({ players: ["Ada", "Bo"], rules: { entryThreshold: 500 } });
    expect(needsEntry(g.view().context)).toBe(true);
    expect(turnHint(g.view()).text).toBe("Bank 500+ in one turn to get on the board");
    g.roll(1, 1, 1, 2, 3, 5);
    g.select(0);
    expect(actionsFor(g.view()).bank).toEqual({ label: "Bank 100", enabled: false, event: "bank" });
    expect(turnHint(g.view())).toEqual({ tone: "warn", text: "400 more needed to get on the board" });
    g.select(1, 2);
    expect(actionsFor(g.view()).bank).toEqual({ label: "Bank 1,000", enabled: true, event: "bank" });
    g.send({ type: "bank" });
    g.roll(2, 3, 4, 6, 6, 2);
    g.send({ type: "passTurn" });
    expect(needsEntry(g.view().context)).toBe(false);
  });
});

describe("turnHint", () => {
  test("follows the selection", () => {
    const g = startGame();
    expect(turnHint(g.view()).text).toBe("Roll the dice to start");
    g.roll(1, 2, 3, 4, 6, 5);
    expect(turnHint(g.view()).tone).toBe("info");
    g.select(1);
    expect(turnHint(g.view())).toEqual({ tone: "warn", text: "Those dice don't score. Try another pick" });
    g.select(1, 0);
    expect(turnHint(g.view()).text).toBe("Keep rolling or bank your points");
  });

  test("a farkle says what was lost", () => {
    const g = startGame();
    g.roll(1, 2, 3, 4, 6, 6);
    g.select(0);
    g.roll(2, 3, 4, 6, 6);
    expect(turnHint(g.view())).toEqual({ tone: "bad", text: "No scoring dice. 100 points lost" });
  });
});

describe("scoringRows", () => {
  test("reflects the default table", () => {
    const rows = scoringRows(DEFAULT_SCORING);
    const points = Object.fromEntries(rows.map((r) => [r.label, r.points]));
    expect(points).toMatchObject({
      "Single 1": 100,
      "Single 5": 50,
      "Three 1s": 1000,
      "Three 2s": 200,
      "Three 6s": 600,
      "Four of a kind": 1000,
      "Six of a kind": 3000,
      Straight: 1500,
      "Two triplets": 2500,
    });
    expect(rows.filter((r) => r.sixDice).map((r) => r.label)).toEqual([
      "Straight",
      "Three pairs",
      "Four of a kind + pair",
      "Two triplets",
    ]);
  });

  test("reflects house rules", () => {
    const rows = scoringRows({ ...DEFAULT_SCORING, threeOnes: 300, threeOfAKindMultiplier: 50, straight: 2000 });
    const points = Object.fromEntries(rows.map((r) => [r.label, r.points]));
    expect(points["Three 1s"]).toBe(300);
    expect(points["Three 4s"]).toBe(200);
    expect(points["Straight"]).toBe(2000);
  });
});
