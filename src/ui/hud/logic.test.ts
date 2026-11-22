import { describe, expect, test } from "vitest";
import { createActor } from "xstate";
import { farkleMachine, type GameInput } from "../../game/machine";
import { DEFAULT_SCORING, type DieValue } from "../../game/scoring";
import {
  LOCAL_TABLE,
  actionsFor,
  blockedReason,
  burstFeedback,
  gameOverLabels,
  isMyTurn,
  isYou,
  onlineWinnerHeadline,
  replayStatus,
  seatLabel,
  turnCue,
  turnTitle,
  upNextText,
  watchingHint,
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
  keepStrip,
  keepChipLabel,
  splitComboFace,
  splitComboTip,
  farkleRisk,
  rollRisk,
  rollRiskText,
  formatRisk,
  dismissedTips,
  dismissTip,
  floatAnchor,
  TIPS_STORAGE_KEY,
  type Feedback,
  type Table,
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

describe("online play", () => {
  // This device is Bo (seat 1) in a three-player online game.
  const me: Table = { online: true, seated: true, bots: [], mySeats: [1] };
  const game = () => startGame({ players: ["Ada", "Bo", "Cy"] });
  const passTurn = (g: ReturnType<typeof game>) => {
    g.roll(2, 3, 4, 6, 6, 2);
    g.send({ type: "passTurn" });
  };

  test("only my online seat is 'You'; local seats never are", () => {
    expect(isYou(me, 1)).toBe(true);
    expect(isYou(me, 0)).toBe(false);
    expect(isYou({ online: false, seated: false, bots: [], mySeats: [0, 1, 2] }, 1)).toBe(false);
    expect(isYou(LOCAL_TABLE, 0)).toBe(false);
    expect(seatLabel("Bo", 1, me)).toBe("You");
    expect(seatLabel("Ada", 0, me)).toBe("Ada");
    expect(seatLabel("Bo", 1, LOCAL_TABLE)).toBe("Bo");
  });

  test("my turn: every turn locally, only my seat online, never once the game is over", () => {
    const g = game();
    expect(isMyTurn(g.view(), LOCAL_TABLE)).toBe(true);
    expect(isMyTurn(g.view(), me)).toBe(false);
    expect(turnTitle(g.view(), me)).toBe("Ada's turn");
    passTurn(g);
    expect(isMyTurn(g.view(), me)).toBe(true);
    expect(turnTitle(g.view(), me)).toBe("Your turn");
    expect(turnTitle(g.view(), LOCAL_TABLE)).toBe("Bo's turn");
    expect(turnCue(g.view(), me)).toEqual({ kind: "turn", text: "Your turn" });

    const solo = startGame({ players: ["Ada"], rules: { targetScore: 1000 } });
    solo.roll(1, 1, 1, 2, 3, 4);
    solo.select(0, 1, 2);
    solo.send({ type: "bank" });
    expect(isMyTurn(solo.view(), LOCAL_TABLE)).toBe(false);
    expect(turnCue(solo.view(), LOCAL_TABLE)).toBeNull();
  });

  test("watching another player: what they are doing in each phase", () => {
    const g = game();
    expect(watchingHint(g.view())).toEqual({ tone: "info", text: "Waiting for Ada to roll" });
    g.send({ type: "roll" });
    expect(watchingHint(g.view()).text).toBe("Ada is rolling…");
    g.send({ type: "rolled", values: [1, 2, 3, 4, 6, 6] });
    expect(watchingHint(g.view()).text).toBe("Ada is choosing dice…");
    g.select(0);
    expect(watchingHint(g.view()).text).toBe("Ada is choosing dice… +100 so far");
    g.roll(2, 3, 4, 6, 6);
    expect(watchingHint(g.view())).toEqual({ tone: "bad", text: "Ada farkled and lost 100" });
    g.send({ type: "passTurn" });
    passTurn(g);
    g.roll(2, 3, 4, 6, 6, 2);
    expect(watchingHint(g.view()).text).toBe("Cy farkled");
  });

  test("an away player gets a patient message", () => {
    const g = game();
    expect(watchingHint(g.view(), true).text).toBe("Ada is away. They can roll whenever they're back");
    g.roll(1, 2, 3, 4, 6, 6);
    expect(watchingHint(g.view(), true).text).toBe("Ada is away, mid-turn");
    // What already happened is reported the same either way.
    g.select(0);
    g.roll(2, 3, 4, 6, 6);
    expect(watchingHint(g.view(), true).text).toBe("Ada farkled and lost 100");
  });

  test("how long until my turn", () => {
    const cy: Table = { online: true, seated: true, bots: [], mySeats: [2] };
    const g = game();
    expect(upNextText(g.view(), cy)).toBe("You're up in 2 turns");
    expect(upNextText(g.view(), me)).toBe("You're up next");
    expect(upNextText(g.view(), { online: true, seated: true, bots: [], mySeats: [0] })).toBeNull();
    expect(upNextText(g.view(), LOCAL_TABLE)).toBeNull();
  });

  test("in the final round, a player whose turns are done is told so", () => {
    const g = startGame({ players: ["Ada", "Bo", "Cy"], rules: { targetScore: 1000 } });
    passTurn(g);
    // Bo (me) reaches the target; Cy and Ada still roll, I don't.
    g.roll(1, 1, 1, 2, 3, 4);
    g.select(0, 1, 2);
    g.send({ type: "bank" });
    expect(upNextText(g.view(), me)).toBe("Final round: you've had your last turn");
    expect(upNextText(g.view(), { online: true, seated: true, bots: [], mySeats: [0] })).toBe("You're up next");
    expect(upNextText(g.view(), { online: true, seated: true, bots: [], mySeats: [2] })).toBeNull();
  });

  test("the HUD's burst detection relies on one snapshot per event", () => {
    const actor = createActor(farkleMachine, { input: { players: ["Ada", "Bo"] } }).start();
    let emitted = 0;
    actor.subscribe(() => emitted++);
    const expectOne = (event: Parameters<typeof actor.send>[0]) => {
      const before = emitted;
      actor.send(event);
      expect(emitted - before).toBe(1);
    };
    expectOne({ type: "roll" });
    expectOne({ type: "rolled", values: [1, 2, 3, 4, 6, 6] });
    expectOne({ type: "toggleDie", index: 0 });
    // Banking passes through the `turnEnded` choice state: still a single snapshot.
    expectOne({ type: "bank" });
  });

  test("replay status names the turn being replayed and tracks progress", () => {
    const g = game();
    expect(replayStatus(g.view(), me, 3, 12)).toEqual({
      text: "Catching up: Ada's turn…",
      progress: 0.25,
      detail: "3 of 12 moves",
    });
    passTurn(g);
    expect(replayStatus(g.view(), me, 12, 12)).toMatchObject({ text: "Catching up: your turn…", progress: 1 });
    // Defensive: an empty or shrinking log never divides by zero or overshoots.
    expect(replayStatus(g.view(), me, 0, 0).progress).toBe(1);
    expect(replayStatus(g.view(), me, 9, 4)).toMatchObject({ progress: 1, detail: "4 of 4 moves" });
  });

  test("my buttons explain themselves while reconnecting", () => {
    const g = game();
    expect(blockedReason(g.view(), true)).toBeNull();
    expect(blockedReason(g.view(), false)).toMatch(/^Reconnecting/);
  });

  test("game over: headline from my seat and online button labels", () => {
    const players = [
      { name: "Ada", score: 900 },
      { name: "Bo", score: 900 },
      { name: "Cy", score: 100 },
    ];
    expect(onlineWinnerHeadline(players, [1], me)).toBe("You win!");
    expect(onlineWinnerHeadline(players, [0], me)).toBe("Ada wins!");
    expect(onlineWinnerHeadline(players, [0, 1], me)).toBe("You and Ada tie!");
    expect(onlineWinnerHeadline(players, [0, 1], LOCAL_TABLE)).toBe("Ada and Bo tie!");
    expect(gameOverLabels(true)).toEqual({ again: "Rematch", leave: "Back to games" });
    expect(gameOverLabels(false)).toEqual({ again: "Play again", leave: "New game" });
  });

  test("a skipped run of moves is silent unless it ended the game", () => {
    const g = startGame({ players: ["Ada", "Bo"], rules: { targetScore: 1000 } });
    const start = g.view();
    g.roll(1, 1, 1, 2, 3, 4);
    g.select(0, 1, 2);
    g.send({ type: "bank" });
    expect(burstFeedback(start, g.view())).toEqual({ banners: [], sounds: [] });
    g.roll(2, 3, 4, 6, 6, 2);
    g.send({ type: "passTurn" });
    expect(burstFeedback(start, g.view())).toEqual({ banners: [], sounds: ["win"] });
    expect(burstFeedback(g.view(), g.view())).toEqual({ banners: [], sounds: [] });
  });
});

describe("keeps", () => {
  test("three 5s over three rolls are three 50 chips, plus the pending pick", () => {
    const g = startGame();
    g.roll(5, 2, 3, 4, 6, 6);
    g.select(0);
    g.roll(5, 2, 3, 4, 6);
    g.select(1);
    g.roll(5, 2, 3, 4);
    g.select(2);
    const strip = keepStrip(g.view(), 1000);
    expect(strip.hidden).toBe(0);
    expect(strip.chips.map((c) => [c.faces, c.points, c.pending])).toEqual([
      [[5], 50, false],
      [[5], 50, false],
      [[5], 50, true],
    ]);
    expect(splitComboFace(g.view())).toBe(5);
    expect(keepChipLabel(strip.chips[2]!)).toBe("Picked 5 for 50 points");
  });

  test("a combo in one roll is one chip and no tip; hot dice are marked", () => {
    const g = startGame();
    g.roll(5, 5, 5, 1, 2, 3);
    g.select(0, 1, 2, 3);
    expect(splitComboFace(g.view())).toBeNull();
    g.roll(1, 5);
    g.select(4, 5);
    const chips = keepStrip(g.view(), 1000).chips;
    expect(chips.map((c) => [c.faces, c.points, c.hotDice])).toEqual([
      [[1, 5, 5, 5], 600, false],
      [[1, 5], 150, true],
    ]);
    expect(keepChipLabel(chips[0]!)).toBe("Kept 1, 5, 5, 5 for 600 points");
    expect(keepChipLabel(chips[1]!)).toMatch(/hot dice$/);
    // Two 1s and five 5s are spread over two keeps; 5s are 3+ in total -> tip.
    expect(splitComboFace(g.view())).toBe(5);
  });

  test("an invalid pick adds no chip, and the oldest keeps fold into +N", () => {
    const g = startGame();
    g.roll(1, 2, 3, 4, 6, 6);
    g.select(0);
    g.roll(1, 2, 3, 4, 6);
    g.select(1);
    g.roll(1, 2, 3, 4);
    g.select(2);
    g.roll(1, 2, 3);
    g.select(4);
    expect(keepStrip(g.view(), 1000).chips).toHaveLength(3);
    const narrow = keepStrip(g.view(), 100);
    expect(narrow.hidden).toBeGreaterThan(0);
    expect(narrow.hiddenPoints).toBe(narrow.hidden * 100);
    expect(narrow.hidden + narrow.chips.length).toBe(3);
    // Never folds the last chip.
    expect(keepStrip(g.view(), 0).chips).toHaveLength(1);
  });

  test("tip text follows the rules", () => {
    expect(splitComboTip(DEFAULT_SCORING)).toBe(
      "Combos only count within a single roll. Three 5s from separate rolls are 50 each (not 500).",
    );
  });
});

describe("farkle risk", () => {
  test("standard scoring", () => {
    const pct = (n: number) => Math.round(farkleRisk(n, DEFAULT_SCORING) * 1000) / 10;
    expect([1, 2, 3, 4, 5, 6].map(pct)).toEqual([66.7, 44.4, 27.8, 15.7, 7.7, 2.3]);
    expect(farkleRisk(0, DEFAULT_SCORING)).toBe(0);
  });

  test("next roll: free dice, minus the pick, hot dice back to six", () => {
    const g = startGame();
    expect(rollRiskText(rollRisk(g.view())!)).toBe("6 dice · 2% farkle risk");
    g.roll(1, 2, 3, 4, 6, 6);
    expect(rollRisk(g.view())).toBeNull(); // nothing picked
    g.select(0);
    expect(rollRiskText(rollRisk(g.view())!)).toBe("5 dice · 8% farkle risk");
    g.roll(1, 1, 1, 5, 5);
    g.select(1, 2, 3, 4, 5);
    expect(rollRisk(g.view())!.dice).toBe(6);
    expect(formatRisk(0.001)).toBe("<1%");
    expect(formatRisk(0.278)).toBe("28%");
  });
});

describe("tips and floats", () => {
  test("dismissal is remembered; junk storage is ignored", () => {
    const data = new Map<string, string>();
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(dismissedTips(store)).toEqual([]);
    dismissTip(store, "combosPerRoll");
    expect(dismissedTips(store)).toEqual(["combosPerRoll"]);
    expect(JSON.parse(data.get(TIPS_STORAGE_KEY)!)).toEqual({ dismissed: ["combosPerRoll"] });
    data.set(TIPS_STORAGE_KEY, "{oops");
    expect(dismissedTips(store)).toEqual([]);
    expect(dismissedTips(null)).toEqual([]);
  });

  test("float anchor stays inside the visible strip", () => {
    const strip = { left: 0, right: 390 };
    expect(floatAnchor({ left: 100, right: 200, bottom: 50 }, strip)).toEqual({ x: 150, y: 50 });
    expect(floatAnchor({ left: 500, right: 600, bottom: 50 }, strip).x).toBe(372);
    expect(floatAnchor({ left: -300, right: -200, bottom: 50 }, strip).x).toBe(18);
  });
});
