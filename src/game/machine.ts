import { setup, types } from "xstate";
import { DEFAULT_SCORING, DICE_COUNT, hasScoringDice, scoreDice, type DieValue, type ScoringTable } from "./scoring";

export interface GameRules {
  scoring: ScoringTable;
  /** Banking at or above this score triggers the final round. */
  targetScore: number;
  /** Minimum turn total a player needs to bank their first points. 0 disables it. */
  entryThreshold: number;
}

export const DEFAULT_RULES: GameRules = {
  scoring: DEFAULT_SCORING,
  targetScore: 10_000,
  entryThreshold: 0,
};

export interface Player {
  name: string;
  score: number;
}

export interface Die {
  /** Face showing; null before the first roll of a turn. */
  value: DieValue | null;
  /** Set aside earlier this turn. Held dice aren't rolled again. */
  held: boolean;
  /** Index into `GameContext.keeps` of the keep that set this die aside; null when not held. */
  keep: number | null;
}

/** One set of dice put aside together from a single roll. Combos never span keeps. */
export interface Keep {
  /** Die indices that were kept (into `GameContext.dice` at the time). */
  dice: number[];
  values: DieValue[];
  points: number;
  /** True if this keep used up the last free dice, giving the player all six back. */
  hotDice: boolean;
}

export interface GameContext {
  rules: GameRules;
  players: Player[];
  /** Index into `players` of whose turn it is. */
  current: number;
  /** Points from dice already set aside this turn, not counting the current selection. */
  turnPoints: number;
  dice: Die[];
  /** Indices of dice selected to keep from the latest roll. */
  selected: number[];
  /** Every keep this turn, oldest first (survives hot dice). `turnPoints` is their sum. */
  keeps: Keep[];
  /** Index of the player who reached the target score, starting the final round. */
  finalRoundBy: number | null;
}

export interface GameInput {
  players: string[];
  rules?: Partial<GameRules>;
}

export interface GameOutput {
  winners: number[];
  players: Player[];
}

const freshDice = (): Die[] => Array.from({ length: DICE_COUNT }, () => ({ value: null, held: false, keep: null }));

// ---------------------------------------------------------------------------
// Derived values. Exported so the UI reads game state the same way the machine does.
// ---------------------------------------------------------------------------

export const freeDiceIndices = (ctx: GameContext): number[] =>
  ctx.dice.flatMap((die, i) => (die.held ? [] : [i]));

const valuesAt = (ctx: GameContext, indices: readonly number[]): DieValue[] =>
  indices.map((i) => ctx.dice[i]?.value).filter((v): v is DieValue => v != null);

/** Points for the current selection, or null if it's empty or includes a non-scoring die. */
export const selectionScore = (ctx: GameContext): number | null =>
  scoreDice(valuesAt(ctx, ctx.selected), ctx.rules.scoring);

/** Turn total if the player banked right now with the current selection. */
export const pendingTurnTotal = (ctx: GameContext): number => ctx.turnPoints + (selectionScore(ctx) ?? 0);

export const canBank = (ctx: GameContext): boolean => {
  if (selectionScore(ctx) === null) return false;
  const player = ctx.players[ctx.current];
  const onTheBoard = (player?.score ?? 0) > 0;
  return onTheBoard || pendingTurnTotal(ctx) >= ctx.rules.entryThreshold;
};

export const winners = (players: readonly Player[]): number[] => {
  const top = Math.max(...players.map((p) => p.score));
  return players.flatMap((p, i) => (p.score === top ? [i] : []));
};

/** Context after the current player's turn ends with `points` banked (0 for a farkle). */
function endTurn(ctx: GameContext, points: number): GameContext {
  const players = ctx.players.map((p, i) => (i === ctx.current ? { ...p, score: p.score + points } : p));
  const reachedTarget = (players[ctx.current]?.score ?? 0) >= ctx.rules.targetScore;
  return {
    ...ctx,
    players,
    current: (ctx.current + 1) % players.length,
    turnPoints: 0,
    dice: freshDice(),
    selected: [],
    keeps: [],
    finalRoundBy: ctx.finalRoundBy ?? (reachedTarget ? ctx.current : null),
  };
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

/**
 * Turn flow for one game of Farkle.
 *
 * Dice randomness is not generated here: the UI (physics simulation) decides what was
 * rolled and reports it with a `rolled` event. That keeps every transition deterministic,
 * so games can be replayed, tested, and later validated on a server.
 */
export const farkleMachine = setup({
  schemas: {
    input: types<GameInput>(),
    context: types<GameContext>(),
    output: types<GameOutput>(),
    events: {
      /** Throw every die that isn't held. */
      roll: types<{}>(),
      /** Result of a throw: one value per free die, in index order. */
      rolled: types<{ values: DieValue[] }>(),
      toggleDie: types<{ index: number }>(),
      /** Set the selection aside and throw the remaining dice. */
      keepAndRoll: types<{}>(),
      /** Set the selection aside and add the turn total to the player's score. */
      bank: types<{}>(),
      /** Acknowledge a farkle and pass the dice. */
      passTurn: types<{}>(),
    },
  },
}).createMachine({
  id: "farkle",
  context: ({ input }) => {
    if (input.players.length === 0) throw new Error("Farkle needs at least one player");
    return {
      rules: { ...DEFAULT_RULES, ...input.rules },
      players: input.players.map((name) => ({ name, score: 0 })),
      current: 0,
      turnPoints: 0,
      dice: freshDice(),
      selected: [],
      keeps: [],
      finalRoundBy: null,
    };
  },
  initial: "playing",
  states: {
    playing: {
      initial: "awaitingRoll",
      states: {
        awaitingRoll: {
          on: { roll: { target: "rolling" } },
        },
        rolling: {
          on: {
            rolled: ({ context, event }) => {
              const free = freeDiceIndices(context);
              if (event.values.length !== free.length) return;
              const dice = context.dice.map((die) => ({ ...die }));
              free.forEach((dieIndex, n) => {
                dice[dieIndex]!.value = event.values[n]!;
              });
              const scored = hasScoringDice(event.values, context.rules.scoring);
              return { target: scored ? "choosing" : "farkled", context: { dice, selected: [] } };
            },
          },
        },
        choosing: {
          on: {
            toggleDie: ({ context, event }) => {
              const die = context.dice[event.index];
              if (!die || die.held) return;
              const selected = context.selected.includes(event.index)
                ? context.selected.filter((i) => i !== event.index)
                : [...context.selected, event.index].sort((a, b) => a - b);
              return { context: { selected } };
            },
            keepAndRoll: ({ context }) => {
              const points = selectionScore(context);
              if (points === null) return;
              const keepIndex = context.keeps.length;
              let dice = context.dice.map((die, i) =>
                context.selected.includes(i) ? { ...die, held: true, keep: keepIndex } : die,
              );
              // Hot dice: every die has scored, so the player gets all six back.
              const hotDice = dice.every((die) => die.held);
              if (hotDice) dice = freshDice();
              const keep: Keep = { dice: context.selected, values: valuesAt(context, context.selected), points, hotDice };
              return {
                target: "rolling",
                context: { dice, selected: [], keeps: [...context.keeps, keep], turnPoints: context.turnPoints + points },
              };
            },
            bank: ({ context }) => {
              if (!canBank(context)) return;
              return { target: "#farkle.turnEnded", context: endTurn(context, pendingTurnTotal(context)) };
            },
          },
        },
        farkled: {
          on: {
            passTurn: ({ context }) => ({ target: "#farkle.turnEnded", context: endTurn(context, 0) }),
          },
        },
      },
    },
    turnEnded: {
      type: "choice",
      choice: ({ context }) =>
        context.finalRoundBy === context.current ? { target: "gameOver" } : { target: "playing" },
    },
    gameOver: {
      type: "final",
      output: ({ context }) => ({ winners: winners(context.players), players: context.players }),
    },
  },
});
