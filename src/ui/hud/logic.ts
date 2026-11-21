import {
  canBank,
  freeDiceIndices,
  pendingTurnTotal,
  selectionScore,
  type GameContext,
  type Player,
} from "../../game/machine";
import type { ScoringTable } from "../../game/scoring";

/** Pure HUD logic: everything here is derived from game state and unit-tested. */

export type Phase = "awaitingRoll" | "rolling" | "choosing" | "farkled" | "done";

/** The slice of an actor snapshot the HUD cares about. */
export interface HudView {
  phase: Phase;
  context: GameContext;
}

interface SnapshotLike {
  status: string;
  context: GameContext;
  matches: (value: { playing: "awaitingRoll" | "rolling" | "choosing" | "farkled" }) => boolean;
}

export function phaseOf(snapshot: SnapshotLike): Phase {
  if (snapshot.status === "done") return "done";
  if (snapshot.matches({ playing: "rolling" })) return "rolling";
  if (snapshot.matches({ playing: "choosing" })) return "choosing";
  if (snapshot.matches({ playing: "farkled" })) return "farkled";
  return "awaitingRoll";
}

export const viewOf = (snapshot: SnapshotLike): HudView => ({
  phase: phaseOf(snapshot),
  context: snapshot.context,
});

export const formatPoints = (n: number): string => n.toLocaleString("en-US");

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

export type BannerKind = "farkle" | "hotDice" | "banked" | "finalRound";
export type SoundKind = "farkle" | "hotDice" | "bank" | "win";

export interface Banner {
  kind: BannerKind;
  text: string;
}

export interface Feedback {
  banners: Banner[];
  sounds: SoundKind[];
}

/**
 * What to announce for a state change. The machine emits no events, so the HUD compares
 * consecutive snapshots instead.
 */
export function diffFeedback(prev: HudView, next: HudView): Feedback {
  const banners: Banner[] = [];
  const sounds: SoundKind[] = [];
  const before = prev.context;
  const after = next.context;
  const gameEnded = prev.phase !== "done" && next.phase === "done";

  if (prev.phase !== "farkled" && next.phase === "farkled") {
    banners.push({ kind: "farkle", text: "Farkle!" });
    sounds.push("farkle");
  }

  // Keeping every free die resets all six: the selection was the last of the dice.
  if (
    prev.phase === "choosing" &&
    next.phase === "rolling" &&
    before.selected.length > 0 &&
    before.selected.length === freeDiceIndices(before).length
  ) {
    banners.push({ kind: "hotDice", text: "Hot dice!" });
    sounds.push("hotDice");
  }

  const banker = before.players[before.current];
  const banked = (after.players[before.current]?.score ?? 0) - (banker?.score ?? 0);
  if (prev.phase === "choosing" && banker && banked > 0) {
    banners.push({ kind: "banked", text: `${banker.name} banked ${formatPoints(banked)}` });
    // The win fanfare replaces the bank sound on the game-ending bank.
    if (!gameEnded) sounds.push("bank");
  }

  if (before.finalRoundBy === null && after.finalRoundBy !== null && !gameEnded) {
    const name = after.players[after.finalRoundBy]?.name ?? "Someone";
    banners.push({
      kind: "finalRound",
      text: `${name} reached ${formatPoints(after.rules.targetScore)} — final round!`,
    });
  }

  if (gameEnded) sounds.push("win");

  return { banners, sounds };
}

// ---------------------------------------------------------------------------
// Scoreboard
// ---------------------------------------------------------------------------

export interface FinalRoundInfo {
  /** Player who reached the target. */
  by: string;
  /** Players who still get a turn, in play order, starting with the current player. */
  remaining: string[];
}

export function finalRoundInfo(ctx: GameContext): FinalRoundInfo | null {
  if (ctx.finalRoundBy === null) return null;
  const count = ctx.players.length;
  const remaining: string[] = [];
  for (let step = 0; step < count; step++) {
    const index = (ctx.current + step) % count;
    if (index === ctx.finalRoundBy) break;
    remaining.push(ctx.players[index]!.name);
  }
  return { by: ctx.players[ctx.finalRoundBy]?.name ?? "", remaining };
}

/** One line for the scoreboard; long lists collapse to a count so the bar stays slim. */
export function finalRoundText({ by, remaining }: FinalRoundInfo): string {
  const lead = `${by} reached the target.`;
  if (remaining.length === 0) return lead;
  if (remaining.length === 1) return `${lead} ${remaining[0]} has the last turn.`;
  if (remaining.length <= 3) return `${lead} Still to roll: ${joinNames(remaining)}.`;
  return `${lead} ${remaining.length} players still to roll, ${remaining[0]} first.`;
}

export interface RankedPlayer extends Player {
  /** Index into the original players array. */
  index: number;
  /** 1-based; tied players share a rank and the next rank is skipped (1, 1, 3). */
  rank: number;
}

export function rankPlayers(players: readonly Player[]): RankedPlayer[] {
  const sorted = players
    .map((p, index) => ({ ...p, index, rank: 0 }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  sorted.forEach((p, i) => {
    const above = sorted[i - 1];
    p.rank = above && above.score === p.score ? above.rank : i + 1;
  });
  return sorted;
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function winnerHeadline(players: readonly Player[], winnerIndices: readonly number[]): string {
  const names = winnerIndices.map((i) => players[i]?.name ?? "");
  if (names.length === 0) return "Game over";
  if (names.length === 1) return `${names[0]} wins!`;
  return `${joinNames(names)} tie!`;
}

// ---------------------------------------------------------------------------
// Turn panel and actions
// ---------------------------------------------------------------------------

/** The current player still has to make a qualifying first bank. */
export const needsEntry = (ctx: GameContext): boolean =>
  ctx.rules.entryThreshold > 0 && (ctx.players[ctx.current]?.score ?? 0) === 0;

export type HintTone = "info" | "warn" | "bad";

export interface Hint {
  tone: HintTone;
  text: string;
}

export function turnHint({ phase, context: ctx }: HudView): Hint {
  const entry = needsEntry(ctx) ? ctx.rules.entryThreshold : 0;
  switch (phase) {
    case "awaitingRoll":
      return {
        tone: "info",
        text: entry > 0 ? `Bank ${formatPoints(entry)}+ in one turn to get on the board` : "Roll the dice to start",
      };
    case "rolling":
      return { tone: "info", text: "Rolling…" };
    case "farkled":
      return {
        tone: "bad",
        text: ctx.turnPoints > 0 ? `No scoring dice. ${formatPoints(ctx.turnPoints)} points lost` : "No scoring dice",
      };
    case "done":
      return { tone: "info", text: "Game over" };
    case "choosing": {
      if (ctx.selected.length === 0) return { tone: "info", text: "Tap the scoring dice you want to keep" };
      if (selectionScore(ctx) === null) return { tone: "warn", text: "Those dice don't score. Try another pick" };
      const total = pendingTurnTotal(ctx);
      if (entry > 0 && total < entry) {
        return { tone: "warn", text: `${formatPoints(entry - total)} more needed to get on the board` };
      }
      if (ctx.selected.length === freeDiceIndices(ctx).length) {
        return { tone: "info", text: "Every die scored. Roll all six again or bank" };
      }
      return { tone: "info", text: "Keep rolling or bank your points" };
    }
  }
}

export interface ActionButton {
  label: string;
  enabled: boolean;
  event: "roll" | "keepAndRoll" | "bank" | "passTurn" | null;
  hotDice?: boolean;
}

export interface Actions {
  primary: ActionButton;
  /** Only offered while choosing. */
  bank: ActionButton | null;
}

export function actionsFor({ phase, context: ctx }: HudView): Actions {
  switch (phase) {
    case "awaitingRoll":
      return { primary: { label: "Roll", enabled: true, event: "roll" }, bank: null };
    case "rolling":
    case "done":
      return { primary: { label: "Rolling…", enabled: false, event: null }, bank: null };
    case "farkled":
      return { primary: { label: "Pass dice", enabled: true, event: "passTurn" }, bank: null };
    case "choosing": {
      const valid = selectionScore(ctx) !== null;
      const remaining = freeDiceIndices(ctx).length - ctx.selected.length;
      const hotDice = valid && remaining === 0;
      let label = "Keep & roll";
      if (hotDice) label = "Hot dice! Roll all 6";
      else if (valid) label = `Keep & roll ${remaining} ${remaining === 1 ? "die" : "dice"}`;
      return {
        primary: { label, enabled: valid, event: "keepAndRoll", hotDice },
        bank: {
          label: valid ? `Bank ${formatPoints(pendingTurnTotal(ctx))}` : "Bank",
          enabled: canBank(ctx),
          event: "bank",
        },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Scoring reference
// ---------------------------------------------------------------------------

export interface ScoringRow {
  label: string;
  /** Example dice for the combination. */
  dice: number[];
  points: number;
  /** Only counts when all six dice are used. */
  sixDice: boolean;
}

/** Scoring combinations for the reference panel, built from the active (house) rules. */
export function scoringRows(table: ScoringTable): ScoringRow[] {
  const row = (label: string, dice: number[], points: number, sixDice = false): ScoringRow => ({
    label,
    dice,
    points,
    sixDice,
  });
  return [
    row("Single 1", [1], table.singleOne),
    row("Single 5", [5], table.singleFive),
    row("Three 1s", [1, 1, 1], table.threeOnes),
    ...[2, 3, 4, 5, 6].map((face) =>
      row(`Three ${face}s`, [face, face, face], face * table.threeOfAKindMultiplier),
    ),
    row("Four of a kind", [4, 4, 4, 4], table.fourOfAKind),
    row("Five of a kind", [4, 4, 4, 4, 4], table.fiveOfAKind),
    row("Six of a kind", [4, 4, 4, 4, 4, 4], table.sixOfAKind),
    row("Straight", [1, 2, 3, 4, 5, 6], table.straight, true),
    row("Three pairs", [2, 2, 4, 4, 6, 6], table.threePairs, true),
    row("Four of a kind + pair", [3, 3, 3, 3, 6, 6], table.fourOfAKindAndPair, true),
    row("Two triplets", [2, 2, 2, 5, 5, 5], table.twoTriplets, true),
  ];
}
