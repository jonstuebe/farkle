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

export type BannerKind = "farkle" | "hotDice" | "banked" | "finalRound" | "turn";
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

// ---------------------------------------------------------------------------
// Online play: seats, whose turn, replay
// ---------------------------------------------------------------------------

/** Who is at the table from this device's point of view. */
export interface Table {
  /** Online games give this device one seat; locally every seat is "mine". */
  online: boolean;
  mySeats: readonly number[];
}

export const LOCAL_TABLE: Table = { online: false, mySeats: [] };

/** A seat this device plays in an online game (the one to call "You"). */
export const isYou = (table: Table, seat: number): boolean => table.online && table.mySeats.includes(seat);

/** True when the HUD should offer actions for the current player: always locally, my seat online. */
export const isMyTurn = ({ phase, context }: HudView, table: Table): boolean =>
  phase !== "done" && (!table.online || table.mySeats.includes(context.current));

const currentName = (ctx: GameContext): string => ctx.players[ctx.current]?.name ?? "Someone";

/** "Your turn" for my online seat, otherwise "Bo's turn". */
export function turnTitle(view: HudView, table: Table): string {
  if (isYou(table, view.context.current)) return "Your turn";
  return `${currentName(view.context)}'s turn`;
}

/** Cue shown when a turn lands on someone new (after a replay, or when play reaches my seat). */
export function turnCue(view: HudView, table: Table): Banner | null {
  if (view.phase === "done") return null;
  return { kind: "turn", text: turnTitle(view, table) };
}

/**
 * What another player is doing, for when it isn't my turn. `away` (online, seat not connected)
 * softens the wait: play is asynchronous, so they may be gone for a while.
 */
export function watchingHint({ phase, context: ctx }: HudView, away = false): Hint {
  const name = currentName(ctx);
  switch (phase) {
    case "awaitingRoll":
      return {
        tone: "info",
        text: away ? `${name} is away. They can roll whenever they're back` : `Waiting for ${name} to roll`,
      };
    case "rolling":
      return { tone: "info", text: `${name} is rolling…` };
    case "choosing": {
      if (away) return { tone: "info", text: `${name} is away, mid-turn` };
      const picked = selectionScore(ctx);
      return {
        tone: "info",
        text: picked === null ? `${name} is choosing dice…` : `${name} is choosing dice… +${formatPoints(picked)} so far`,
      };
    }
    case "farkled":
      return {
        tone: "bad",
        text: ctx.turnPoints > 0 ? `${name} farkled and lost ${formatPoints(ctx.turnPoints)}` : `${name} farkled`,
      };
    case "done":
      return { tone: "info", text: "Game over" };
  }
}

/** Seats that still get a turn (current player first). Everyone, until the final round starts. */
function seatsStillToPlay(ctx: GameContext): number[] {
  const count = ctx.players.length;
  const seats: number[] = [];
  for (let step = 0; step < count; step++) {
    const seat = (ctx.current + step) % count;
    if (seat === ctx.finalRoundBy) break;
    seats.push(seat);
  }
  return seats;
}

/** For the player who is waiting online: how far away their turn is. Null when it is their turn. */
export function upNextText({ phase, context: ctx }: HudView, table: Table): string | null {
  if (phase === "done" || !table.online) return null;
  const waits = table.mySeats
    .map((seat) => seatsStillToPlay(ctx).indexOf(seat))
    .filter((turns) => turns >= 0);
  if (waits.length === 0) return ctx.finalRoundBy === null ? null : "Final round: you've had your last turn";
  const turns = Math.min(...waits);
  if (turns === 0) return null;
  return turns === 1 ? "You're up next" : `You're up in ${turns} turns`;
}

/** Why my own buttons are disabled although it is my turn, or null when nothing is in the way. */
export function blockedReason(view: HudView, connected: boolean): string | null {
  if (view.phase === "done") return null;
  return connected ? null : "Reconnecting… you can move again in a moment";
}

export interface ReplayStatus {
  /** e.g. "Catching up: Bo's turn…" */
  text: string;
  /** 0..1 of the log watched so far. */
  progress: number;
  /** e.g. "12 of 40 moves" */
  detail: string;
}

export function replayStatus(view: HudView, table: Table, fed: number, total: number): ReplayStatus {
  const whose = view.phase === "done" ? "the finish" : isYou(table, view.context.current) ? "your turn" : turnTitle(view, table);
  const safeTotal = Math.max(total, 0);
  const safeFed = Math.min(Math.max(fed, 0), safeTotal);
  return {
    text: `Catching up: ${whose}…`,
    progress: safeTotal === 0 ? 1 : safeFed / safeTotal,
    detail: `${safeFed} of ${safeTotal} moves`,
  };
}

/** The scoreboard needs both the name and the "You" tag; other places want one short label. */
export const seatLabel = (name: string, seat: number, table: Table): string => (isYou(table, seat) ? "You" : name);

/** Game-over headline from this device's seat: "You win!", "You and Bo tie!", "Bo wins!". */
export function onlineWinnerHeadline(players: readonly Player[], winnerIndices: readonly number[], table: Table): string {
  if (!table.online) return winnerHeadline(players, winnerIndices);
  // "You" first reads best: "You and Bo tie!"
  const ordered = [...winnerIndices].sort((a, b) => Number(isYou(table, b)) - Number(isYou(table, a)));
  const names = ordered.map((i) => seatLabel(players[i]?.name ?? "", i, table));
  if (names.length === 0) return "Game over";
  if (names.length === 1) return names[0] === "You" ? "You win!" : `${names[0]} wins!`;
  return `${joinNames(names)} tie!`;
}

export interface GameOverLabels {
  again: string;
  leave: string;
}

export const gameOverLabels = (online: boolean): GameOverLabels =>
  online ? { again: "Rematch", leave: "Back to games" } : { again: "Play again", leave: "New game" };

/**
 * Feedback for a run of state changes that landed in one go (a skipped replay, or a batch of
 * moves after reconnecting). Nothing in the run was watched, so stay quiet apart from the one
 * thing that still matters: the game ended.
 */
export function burstFeedback(first: HudView, last: HudView): Feedback {
  const ended = first.phase !== "done" && last.phase === "done";
  return { banners: [], sounds: ended ? ["win"] : [] };
}
