/**
 * The Presenter turns a session's log into what the player watches.
 *
 * It owns a local xstate actor (the *presented* game, which the HUD and scene read through
 * FarkleContext) and feeds it log entries one at a time:
 *
 * - Entries the player had already seen (`seenFrom`) are applied instantly on open.
 * - Throws: after feeding `roll`/`keepAndRoll` the actor is in `playing.rolling`, and the
 *   presenter exposes the upcoming values as `pendingThrow`. The scene animates the dice landing
 *   on exactly those values, then calls `throwSettled(seq)`, and only then is `rolled` fed.
 * - Replay: entries the player hasn't seen yet (other players' turns since they last looked) are
 *   fed with short pauses so the turn can be watched; `skip()` jumps straight to the latest state
 *   (the scene then seats the dice from context instead of throwing).
 * - Live: new entries (own moves or other players' moves while watching) are fed as they arrive,
 *   with the same throw hand-off.
 *
 * Framework-free; React bindings live in ./react.tsx.
 */
import { createActor, type Actor } from "xstate";
import { farkleMachine, freeDiceIndices } from "./machine";
import { isThrowStart } from "./log";
import type { GameSession } from "./session";
import type { DieValue } from "./scoring";

export type GameActor = Actor<typeof farkleMachine>;

/** A throw the scene must animate. */
export interface PendingThrow {
  /** seq of the `rolled` entry; pass it back to `throwSettled`. */
  seq: number;
  /** Dice being thrown (ascending die indices), and the value each must land on. */
  indices: number[];
  values: DieValue[];
}

export interface PresenterView {
  /** Entries fed into the presented actor so far. */
  fed: number;
  /** Length of the authoritative log. */
  total: number;
  pendingThrow: PendingThrow | null;
  /** True while replaying entries the player missed (skippable). */
  replaying: boolean;
  /** Log position where the current replay ends. */
  replayEnd: number;
  /** Bumped by `skip()` (and by catch-up jumps) so the scene knows to seat dice instantly. */
  snapCount: number;
}

/** Pause before feeding the next replayed entry, by event type (ms). */
export const REPLAY_PACING: Record<string, number> = {
  roll: 450,
  keepAndRoll: 650,
  toggleDie: 380,
  bank: 900,
  passTurn: 1100,
};
/** Pause after a live entry from another device before feeding the next (ms). */
export const LIVE_PACING = 250;

export interface PresenterOptions {
  /** Scale replay pauses (tests use 0). */
  pacing?: number;
}

export class Presenter {
  readonly actor: GameActor;
  private view: PresenterView;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribe: () => void;
  private readonly pacing: number;
  private stopped = false;

  constructor(
    private readonly session: GameSession,
    options: PresenterOptions = {},
  ) {
    this.pacing = options.pacing ?? 1;
    const state = session.getState();
    this.actor = createActor(farkleMachine, { input: state.input });
    this.actor.start();

    // Catch up instantly on everything already watched. Never stop inside a throw: if the seen
    // position falls between `roll` and `rolled`, include the `rolled` too.
    let fed = 0;
    let until = Math.min(state.seenFrom, state.log.length);
    if (until > 0 && isThrowStart(state.log[until - 1]!.event)) until += 1;
    for (; fed < until && fed < state.log.length; fed++) this.actor.send(state.log[fed]!.event);

    this.view = {
      fed,
      total: state.log.length,
      pendingThrow: null,
      replaying: fed < state.log.length,
      replayEnd: state.log.length,
      snapCount: 0,
    };
    this.unsubscribe = session.subscribe(() => this.onSessionChange());
    this.pump();
  }

  getView = (): PresenterView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** True when it's one of this device's seats to act and nothing is still playing out. */
  canAct(): boolean {
    const { fed, total, pendingThrow, replaying } = this.view;
    const snapshot = this.actor.getSnapshot();
    const state = this.session.getState();
    return (
      !replaying &&
      pendingThrow === null &&
      fed === total &&
      state.connected &&
      snapshot.status === "active" &&
      state.mySeats.includes(snapshot.context.current)
    );
  }

  /** The scene finished animating throw `seq`: reveal the result. */
  throwSettled = (seq: number): void => {
    const pending = this.view.pendingThrow;
    if (!pending || pending.seq !== seq) return;
    this.feedNext(); // the `rolled` entry
    this.update({ pendingThrow: null });
    this.schedule(this.view.replaying ? this.delayAfter(seq) : 0);
  };

  /** Jump to the latest state, skipping any replay or throw animation still playing. */
  skip = (): void => {
    this.clearTimer();
    const log = this.session.getState().log;
    while (this.view.fed < log.length) this.feedNext();
    this.update({ pendingThrow: null, replaying: false, snapCount: this.view.snapCount + 1 });
  };

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    this.unsubscribe();
    this.actor.stop();
  }

  // -------------------------------------------------------------------------------------------

  private onSessionChange(): void {
    const total = this.session.getState().log.length;
    if (total !== this.view.total) this.update({ total });
    if (this.timer === null && this.view.pendingThrow === null) this.pump();
  }

  /** Feed entries until something needs to wait (a throw animation or a pacing pause). */
  private pump(): void {
    if (this.stopped) return;
    const log = this.session.getState().log;
    while (this.view.fed < log.length && this.view.pendingThrow === null && this.timer === null) {
      const entry = log[this.view.fed]!;
      this.feedNext();

      if (isThrowStart(entry.event)) {
        const rolled = log[entry.seq + 1];
        if (!rolled || rolled.event.type !== "rolled") break; // wait for the rest of the throw
        const indices = freeDiceIndices(this.actor.getSnapshot().context);
        this.update({ pendingThrow: { seq: rolled.seq, indices, values: rolled.event.values } });
        return;
      }

      const delay = this.view.replaying
        ? this.delayAfter(entry.seq)
        : this.session.getState().mySeats.includes(entry.seat)
          ? 0
          : LIVE_PACING * this.pacing;
      if (delay > 0 && this.view.fed < log.length) this.schedule(delay);
    }
    if (this.view.replaying && this.view.fed >= this.view.replayEnd) this.update({ replaying: false });
  }

  private feedNext(): void {
    const entry = this.session.getState().log[this.view.fed];
    if (!entry) return;
    this.actor.send(entry.event);
    const fed = this.view.fed + 1;
    this.update({ fed });
    this.session.markSeen(fed);
    if (this.view.replaying && fed >= this.view.replayEnd) this.update({ replaying: false });
  }

  private delayAfter(seq: number): number {
    const next = this.session.getState().log[seq + 1];
    return next ? (REPLAY_PACING[next.event.type] ?? 400) * this.pacing : 0;
  }

  private schedule(delay: number): void {
    this.clearTimer();
    if (delay <= 0) {
      this.pump();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pump();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private update(patch: Partial<PresenterView>): void {
    this.view = { ...this.view, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}
