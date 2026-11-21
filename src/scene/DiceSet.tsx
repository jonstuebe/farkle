import { useCallback, useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Euler, Quaternion } from "three";
import { playSelect } from "../audio/sfx";
import { freeDiceIndices, type Die as GameDie } from "../game/machine";
import { useCanAct, useGameActor, useGameIntent, useGameSelector, usePendingThrow, useThrowSettled } from "../game/react";
import { Die, type DieHandle } from "./Die";
import {
  assignHeldSlots,
  faceUpQuaternion,
  heldSlotPosition,
  isCocked,
  makeThrow,
  phaseOf,
  readyPosition,
  rolledValues,
  type Phase,
} from "./diceLayout";
import type { DieValue } from "./dice";

declare global {
  interface Window {
    /** Dev only: the game actor, for driving the game from the console or a test script. */
    __farkle?: unknown;
    /** Dev only: lets tests check that every throw produced exactly one `rolled`. */
    __farkleStats?: DiceStats;
  }
}

interface DiceStats {
  /** Throws started (entries into `playing.rolling` the scene acted on). */
  throws: number;
  /** `rolled` events sent to the machine. */
  rolledSent: number;
  /** Throws resolved by the hard backstop instead of settling normally. */
  forced: number;
  /** Times cocked / stacked dice were kicked. */
  nudges: number;
  /** Test switch (dev builds only): ignore normal settling so only the backstop can resolve. */
  holdSettle: boolean;
}

const stats: DiceStats = { throws: 0, rolledSent: 0, forced: 0, nudges: 0, holdSettle: false };

const DICE = [0, 1, 2, 3, 4, 5] as const;

/** All thrown dice must be still for this long before the throw is read. */
const SETTLE_SECONDS = 0.3;
/** After this long in the air/on the felt, the throw is read no matter what. */
const THROW_TIMEOUT_SECONDS = 6;
/** How many times cocked dice get kicked before we give up and read them as they lie. */
const MAX_NUDGES = 3;
/**
 * Hard backstop: this long after a throw starts it is read as it lies, whatever state the
 * dice are in. Measured in frame time (long stalls such as a hidden tab count as 0.25 s).
 */
const HARD_TIMEOUT_SECONDS = THROW_TIMEOUT_SECONDS + 1;

interface ActiveThrow {
  /** Die indices in the air, ascending. */
  indices: number[];
  /** Seconds since the dice were released. */
  elapsed: number;
  /** Seconds since the throw started, counting carried time too (for the hard backstop). */
  age: number;
  stillFor: number;
  nudges: number;
  sent: boolean;
}

interface Seen {
  phase: Phase | null;
  dice: readonly GameDie[] | null;
  slots: (number | null)[];
  /** Value of the rolling-entry counter this was recorded at. */
  entries: number;
}

/**
 * The six dice, driven by the game machine.
 *
 * All flow control lives in one frame loop that compares the actor's current snapshot with
 * the last one it acted on. That makes it immune to StrictMode's doubled effects and means
 * a throw is started, and its result sent, exactly once.
 */
export function DiceSet() {
  const actor = useGameActor();
  const sendIntent = useGameIntent();
  const throwSettled = useThrowSettled();
  // INTERIM (coordinator): dice values now come from the log, not the physics. Until the scene
  // lands dice on `pendingThrow.values`, a settled throw just reports back to the presenter.
  const pendingThrow = usePendingThrow();
  const pendingRef = useRef(pendingThrow);
  pendingRef.current = pendingThrow;
  const canAct = useCanAct();
  const canActRef = useRef(canAct);
  canActRef.current = canAct;
  const handles = useRef<(DieHandle | null)[]>([]);
  const seen = useRef<Seen>({ phase: null, dice: null, slots: [], entries: 0 });
  // Counts every entry into `playing.rolling`, straight from the actor. The frame loop can
  // miss a phase entirely (a throw is resolved and the next one requested between two
  // frames, e.g. a quick keypress during a hitch), so "phase changed" is not enough to
  // know a new throw is due; this counter is.
  const rollingEntries = useRef(0);
  const activeThrow = useRef<ActiveThrow | null>(null);

  // Render-side state: only what the dice need for interaction and highlights.
  const phase = useGameSelector((snapshot) => phaseOf(snapshot.value));
  const dice = useGameSelector((snapshot) => snapshot.context.dice);
  const selected = useGameSelector((snapshot) => snapshot.context.selected);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__farkle = actor;
    return () => {
      if (window.__farkle === actor) delete window.__farkle;
    };
  }, [actor]);

  useEffect(() => {
    let previous = phaseOf(actor.getSnapshot().value);
    const subscription = actor.subscribe((snapshot) => {
      const next = phaseOf(snapshot.value);
      if (next === "rolling" && previous !== "rolling") rollingEntries.current += 1;
      previous = next;
    });
    return () => subscription.unsubscribe();
  }, [actor]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__farkleStats = stats;
  }, []);

  const onToggle = useCallback(
    (index: number) => {
      const snapshot = actor.getSnapshot();
      const die = snapshot.context.dice[index];
      if (!canActRef.current) return;
      if (phaseOf(snapshot.value) !== "choosing" || !die || die.held || die.value === null) return;
      playSelect(!snapshot.context.selected.includes(index));
      sendIntent({ type: "toggleDie", index });
    },
    [actor, sendIntent],
  );

  useFrame((_, rawDelta) => {
    const all = handles.current;
    if (DICE.some((i) => !all[i]?.ready())) return;
    const die = (i: number) => all[i]!;

    const snapshot = actor.getSnapshot();
    const context = snapshot.context;
    const now = phaseOf(snapshot.value);
    const last = seen.current;
    const entries = rollingEntries.current;

    if (now !== last.phase || context.dice !== last.dice || entries !== last.entries) {
      const first = last.phase === null;
      const slots = assignHeldSlots(last.slots, context.dice.map((d) => d.held));

      if (first) {
        // Fresh mount (new game, or a saved game being resumed): seat every die to match
        // the game state without throwing: saved face up, kept dice in their lane slots.
        DICE.forEach((i) => {
          const slot = slots[i] ?? null;
          const value = context.dice[i]?.value ?? null;
          die(i).glideTo(slot !== null ? heldSlotPosition(slot) : readyPosition(i), {
            orientation: value !== null ? faceUpQuaternion(value) : "square",
            duration: 0.01,
            arc: 0,
          });
        });
      } else {
        // Kept dice hop into the lane, each to its own stable slot.
        slots.forEach((slot, i) => {
          if (slot !== null && slot !== last.slots[i]) {
            die(i).glideTo(heldSlotPosition(slot), { orientation: "square", duration: 0.45, arc: 1.1 });
          }
        });
      }

      if (now === "rolling" && (entries !== last.entries || first)) {
        // Scoop the free dice into the "hand" and let them fly.
        const indices = freeDiceIndices(context);
        indices.forEach((index, n) => {
          const launch = makeThrow(n, indices.length);
          die(index).glideTo(launch.position, {
            orientation: new Quaternion().setFromEuler(new Euler(...launch.rotation)),
            duration: 0.24,
            arc: 0.5,
            launch,
          });
        });
        activeThrow.current = { indices, elapsed: 0, age: 0, stillFor: 0, nudges: 0, sent: false };
        stats.throws += 1;
      } else if (now === "awaitingRoll" && last.phase !== "awaitingRoll" && !first) {
        // New turn: gather the free dice into the waiting row. (Mid-turn there is no way
        // back to awaitingRoll, so nothing is held here.)
        activeThrow.current = null;
        DICE.forEach((i) => {
          if (slots[i] == null) die(i).glideTo(readyPosition(i), { orientation: "square", duration: 0.5, arc: 0.9 });
        });
      }
      seen.current = { phase: now, dice: context.dice, slots, entries };
    }

    // --- read the throw once everything has come to rest ---
    const thrown = activeThrow.current;
    if (now !== "rolling" || (thrown?.sent ?? false)) return;

    // Lock the dice in place, then report them, so what was read is what stays on the
    // table: nothing can knock a die after its value has been reported. The dice read are
    // the machine's free dice right now, so the event always has the length it expects.
    const resolve = (forced: boolean) => {
      const indices = freeDiceIndices(context);
      const values = new Map<number, DieValue>();
      for (const i of indices) {
        die(i).halt();
        die(i).freeze(true);
        values.set(i, die(i).read().value);
      }
      const result = rolledValues(indices, values);
      if (thrown) thrown.sent = true;
      if (!result) return;
      stats.rolledSent += 1;
      if (forced) stats.forced += 1;
      const pending = pendingRef.current;
      if (pending) throwSettled(pending.seq);
    };

    // Rolling with no throw on record should be impossible; recover rather than hang.
    if (!thrown) return resolve(true);

    thrown.age += Math.min(rawDelta, 0.25);
    if (thrown.age >= HARD_TIMEOUT_SECONDS) return resolve(true);

    if (import.meta.env.DEV && stats.holdSettle) return;

    const readings = thrown.indices.map((i) => die(i).read());
    if (readings.some((r) => r.gliding)) return;

    const delta = Math.min(rawDelta, 0.05);
    thrown.elapsed += delta;
    thrown.stillFor = readings.every((r) => r.still) ? thrown.stillFor + delta : 0;
    const timedOut = thrown.elapsed >= THROW_TIMEOUT_SECONDS;
    if (thrown.stillFor < SETTLE_SECONDS && !timedOut) return;

    // Leaning on a rail / another die, or stacked: kick those and wait again.
    const cocked = thrown.indices.filter((_, n) => isCocked(readings[n]!.alignment, readings[n]!.y));
    if (cocked.length > 0 && !timedOut && thrown.nudges < MAX_NUDGES) {
      cocked.forEach((i) => die(i).nudge());
      thrown.nudges += 1;
      stats.nudges += 1;
      thrown.stillFor = 0;
      return;
    }

    resolve(false);
  });

  return (
    <>
      {DICE.map((i) => {
        const state = dice[i];
        const free = !!state && !state.held;
        return (
          <Die
            key={i}
            index={i}
            ref={(handle) => {
              handles.current[i] = handle;
            }}
            initialPosition={readyPosition(i)}
            interactive={phase === "choosing" && free && state.value !== null}
            selected={phase === "choosing" && selected.includes(i)}
            dimmed={phase === "farkled" && free}
            onToggle={onToggle}
          />
        );
      })}
    </>
  );
}
