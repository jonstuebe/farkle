import { useCallback, useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Euler, Quaternion } from "three";
import { playSelect } from "../audio/sfx";
import { freeDiceIndices, type Die as GameDie } from "../game/machine";
import { useGameActor, useGameSelector } from "../game/react";
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
  }
}

const DICE = [0, 1, 2, 3, 4, 5] as const;

/** All thrown dice must be still for this long before the throw is read. */
const SETTLE_SECONDS = 0.3;
/** After this long in the air/on the felt, the throw is read no matter what. */
const THROW_TIMEOUT_SECONDS = 6;
/** How many times cocked dice get kicked before we give up and read them as they lie. */
const MAX_NUDGES = 3;

interface ActiveThrow {
  /** Die indices in the air, ascending. */
  indices: number[];
  /** Seconds since the dice were released. */
  elapsed: number;
  stillFor: number;
  nudges: number;
  sent: boolean;
}

interface Seen {
  phase: Phase | null;
  dice: readonly GameDie[] | null;
  slots: (number | null)[];
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
  const handles = useRef<(DieHandle | null)[]>([]);
  const seen = useRef<Seen>({ phase: null, dice: null, slots: [] });
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

  const onToggle = useCallback(
    (index: number) => {
      const snapshot = actor.getSnapshot();
      const die = snapshot.context.dice[index];
      if (phaseOf(snapshot.value) !== "choosing" || !die || die.held || die.value === null) return;
      playSelect(!snapshot.context.selected.includes(index));
      actor.send({ type: "toggleDie", index });
    },
    [actor],
  );

  useFrame((_, rawDelta) => {
    const all = handles.current;
    if (DICE.some((i) => !all[i]?.ready())) return;
    const die = (i: number) => all[i]!;

    const snapshot = actor.getSnapshot();
    const context = snapshot.context;
    const now = phaseOf(snapshot.value);
    const last = seen.current;

    if (now !== last.phase || context.dice !== last.dice) {
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

      if (now === "rolling" && last.phase !== "rolling") {
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
        activeThrow.current = { indices, elapsed: 0, stillFor: 0, nudges: 0, sent: false };
      } else if (now === "awaitingRoll" && last.phase !== "awaitingRoll" && !first) {
        // New turn: gather the free dice into the waiting row. (Mid-turn there is no way
        // back to awaitingRoll, so nothing is held here.)
        activeThrow.current = null;
        DICE.forEach((i) => {
          if (slots[i] == null) die(i).glideTo(readyPosition(i), { orientation: "square", duration: 0.5, arc: 0.9 });
        });
      }
      seen.current = { phase: now, dice: context.dice, slots };
    }

    // --- read the throw once everything has come to rest ---
    const thrown = activeThrow.current;
    if (!thrown || thrown.sent || now !== "rolling") return;
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
      thrown.stillFor = 0;
      return;
    }

    // Lock the dice in place first, so what was read is what stays on the table: nothing
    // can knock a die after its value has been reported.
    const values = new Map<number, DieValue>();
    for (const i of thrown.indices) {
      die(i).freeze(true);
      values.set(i, die(i).read().value);
    }
    const result = rolledValues(thrown.indices, values);
    thrown.sent = true;
    if (result) actor.send({ type: "rolled", values: result });
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
