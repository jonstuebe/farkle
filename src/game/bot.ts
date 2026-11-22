/**
 * Computer players. A bot is just a seat whose intents come from `botIntent` instead of a person.
 *
 * - `botIntent(snapshot)` is the strategy: pure, one intent at a time (roll, pick a die, bank...),
 *   so a bot's turn plays out move by move like a person's would.
 * - `driveBots(session, presenter)` plays the bot seats of a local game: whenever the presented
 *   game has caught up and it is a bot's turn, it waits a beat ("thinking") and sends the next
 *   intent. Waiting for the presenter means every throw is animated and every pick is visible.
 *
 * Strategy, in short: on each roll, weigh every scoring pick by its points plus the value of the
 * dice it leaves to throw (keeping a lone 5 is rarely worth losing a die), then bank once the turn
 * total is high enough for the farkle risk of the dice that are left. Bots respect the entry
 * threshold and, in the final round, keep rolling until they are in the lead.
 *
 * Framework-free, like the presenter.
 */
import { freeDiceIndices, type GameContext } from "./machine";
import type { GameSnapshot, Intent } from "./log";
import type { Presenter } from "./presenter";
import type { GameSession } from "./session";
import { DICE_COUNT, scoreDice, type DieValue } from "./scoring";

/** Most bots a game can have (with one person, that is the 8-seat maximum). */
export const MAX_BOTS = 7;

const BOT_NAMES = ["Ada", "Basil", "Clover", "Dash", "Ember", "Fig", "Juniper", "Moxie", "Pip", "Rook"];

/** `count` distinct bot names, none clashing with the person's name. */
export function botNames(count: number, taken: readonly string[] = []): string[] {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  return BOT_NAMES.filter((name) => !used.has(name.toLowerCase())).slice(0, count);
}

/** Rough worth of throwing `n` dice next (index = n): what keeping one die fewer buys. */
const ROLL_VALUE: readonly number[] = [0, 25, 40, 80, 150, 250, 400];
/** Bank once the turn reaches this, by how many dice the next throw would have (index = dice). */
const BANK_AT: readonly number[] = [0, 300, 300, 400, 1000, 2500, 4000];

export interface BotPick {
  /** Die indices to keep. */
  dice: number[];
  points: number;
  /** Dice the next throw would have after keeping these (six again on hot dice). */
  left: number;
}

/** Every scoring pick from the free dice of the latest roll. */
export function scoringPicks(ctx: GameContext): BotPick[] {
  const free = freeDiceIndices(ctx);
  const picks: BotPick[] = [];
  for (let mask = 1; mask < 1 << free.length; mask++) {
    const dice = free.filter((_, bit) => mask & (1 << bit));
    const values = dice.map((i) => ctx.dice[i]!.value).filter((v): v is DieValue => v != null);
    const points = scoreDice(values, ctx.rules.scoring);
    if (points === null) continue;
    picks.push({ dice, points, left: free.length - dice.length || DICE_COUNT });
  }
  return picks;
}

export interface BotPlan {
  /** The dice to have selected before acting. */
  dice: number[];
  action: "bank" | "keepAndRoll";
}

/** What to keep from the latest roll, and whether to bank it. Null when nothing scores. */
export function planChoice(ctx: GameContext): BotPlan | null {
  const picks = scoringPicks(ctx);
  if (picks.length === 0) return null;

  const most = picks.reduce((best, p) => (p.points > best.points ? p : best));
  const worth = (p: BotPick) => p.points + (ROLL_VALUE[p.left] ?? 0);
  const roll = picks.reduce((best, p) =>
    worth(p) > worth(best) || (worth(p) === worth(best) && p.points > best.points) ? p : best,
  );

  const me = ctx.players[ctx.current]!;
  const bankTotal = ctx.turnPoints + most.points;
  const allowed = me.score > 0 || bankTotal >= ctx.rules.entryThreshold;

  let bank: boolean;
  if (!allowed) {
    bank = false;
  } else if (ctx.finalRoundBy !== null) {
    // Last turn: banking only makes sense if it takes the lead.
    const leader = Math.max(...ctx.players.filter((_, i) => i !== ctx.current).map((p) => p.score));
    bank = me.score + bankTotal > leader;
  } else {
    bank = bankTotal >= (BANK_AT[roll.left] ?? Infinity);
  }
  return bank ? { dice: most.dice, action: "bank" } : { dice: roll.dice, action: "keepAndRoll" };
}

/** The bot's next move for the current seat, or null when there is nothing to do (mid-throw, over). */
export function botIntent(snapshot: GameSnapshot): Intent | null {
  if (snapshot.status !== "active") return null;
  if (snapshot.matches({ playing: "awaitingRoll" })) return { type: "roll" };
  if (snapshot.matches({ playing: "farkled" })) return { type: "passTurn" };
  if (!snapshot.matches({ playing: "choosing" })) return null;

  const ctx = snapshot.context;
  const plan = planChoice(ctx);
  if (!plan) return null;
  // Pick the dice one at a time (and drop any that shouldn't be picked), then act.
  const toggle =
    plan.dice.find((i) => !ctx.selected.includes(i)) ?? ctx.selected.find((i) => !plan.dice.includes(i));
  if (toggle !== undefined) return { type: "toggleDie", index: toggle };
  return { type: plan.action };
}

/** How long a bot "thinks" before each kind of move (ms). */
export const BOT_PACING: Record<Intent["type"], number> = {
  roll: 900,
  toggleDie: 450,
  keepAndRoll: 650,
  bank: 800,
  passTurn: 1200,
};

export interface DriveBotsOptions {
  /** Scale the thinking pauses (tests use 0). */
  pacing?: number;
}

/**
 * Plays the bot seats (`input.bots`) of a local session, at the pace of the presented game.
 * Returns a function that stops it.
 */
export function driveBots(session: GameSession, presenter: Presenter, { pacing = 1 }: DriveBotsOptions = {}): () => void {
  const bots = new Set(session.getState().input.bots ?? []);
  if (bots.size === 0) return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  /** The bot move to make now, if a bot is up and nothing is still playing out. */
  const next = (): Intent | null => {
    const view = presenter.getView();
    if (view.replaying || view.pendingThrow !== null || view.fed !== view.total) return null;
    const snapshot = presenter.actor.getSnapshot();
    if (snapshot.status !== "active" || !bots.has(snapshot.context.current)) return null;
    return botIntent(snapshot);
  };

  const check = () => {
    if (stopped || timer !== null) return;
    const intent = next();
    if (!intent) return;
    timer = setTimeout(() => {
      timer = null;
      if (stopped) return;
      // The game may have moved on while thinking: decide again from what is on the table now.
      const now = next();
      if (now) session.sendIntent(now);
      check();
    }, BOT_PACING[intent.type] * pacing);
  };

  const unsubscribe = presenter.subscribe(check);
  check();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
  };
}
