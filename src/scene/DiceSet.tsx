import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { Quaternion, Vector3 } from "three";
import { playDiceHit, playSelect } from "../audio/sfx";
import type { Die as GameDie, GameContext } from "../game/machine";
import {
  useCanAct,
  useGameActor,
  useGameIntent,
  useGameSelector,
  usePendingThrow,
  useSnapCount,
  useThrowSettled,
} from "../game/react";
import { Die, DIE_DISPLAY_SCALE, type DieHandle, type DieReading } from "./Die";
import {
  faceUpQuaternion,
  keepGroups,
  layoutKeptLane,
  phaseOf,
  readyPosition,
  type Phase,
  type Vec3,
} from "./diceLayout";
import { KeptLaneMarks } from "./KeptLaneMarks";
import { DIE_SIZE } from "./dice";
import { pickDie, tapSlop, type ScreenDie } from "./tapPick";
import { planThrow, samplePlan, type ThrowPlan } from "./throwSim";

declare global {
  interface Window {
    /** Dev only: the presented game actor (read-only), for inspection from a test script. */
    __farkle?: unknown;
    /** Dev only: lets tests check that every throw settled once, on the right faces. */
    __farkleStats?: DiceStats;
    /** Dev only: what each die shows and where it is right now. */
    __farkleDice?: () => DieReading[];
  }
}

interface DiceStats {
  /** Throws started (pending throws the scene began animating). */
  throws: number;
  /** Throws reported back to the presenter with `throwSettled`. */
  settled: number;
  /** Settled throws where a die's top face was not its target value. Must stay 0. */
  mismatches: number;
  /** Throws finished by the hard backstop rather than by playing out. */
  forced: number;
  /** Throws that could not be simulated and were seated directly instead. */
  fallbacks: number;
  /** Throws where no clean landing was found and dice were eased flat at the end. */
  unclean: number;
  /** Dice re-seated because what they showed disagreed with the game state. */
  reseats: number;
  /** Total simulations run (>= throws; more when a landing was cocked and re-thrown). */
  simulations: number;
  /** Time spent planning a throw, in ms. */
  lastPlanMs: number;
  maxPlanMs: number;
  /** Wall-clock time from a throw starting to it settling, in ms. */
  lastSettleMs: number;
  maxSettleMs: number;
  /** Test switch (dev builds only): freeze playback so only the backstop can settle. */
  holdSettle: boolean;
}

const stats: DiceStats = {
  throws: 0,
  settled: 0,
  mismatches: 0,
  forced: 0,
  fallbacks: 0,
  unclean: 0,
  reseats: 0,
  simulations: 0,
  lastPlanMs: 0,
  maxPlanMs: 0,
  lastSettleMs: 0,
  maxSettleMs: 0,
  holdSettle: false,
};

const DICE = [0, 1, 2, 3, 4, 5] as const;

/** Time for the dice to be scooped up into the "hand" before they fly. */
const SCOOP_SECONDS = 0.24;
/**
 * Hard backstop: this long after a throw starts, the dice are put on their final poses and
 * the throw is reported, whatever happened. Measured in frame time (a long stall such as a
 * hidden tab counts as 0.25 s). A normal throw takes at most ~3.7 s.
 */
const HARD_TIMEOUT_SECONDS = 5;
/** At most one hit sound per die in this much playback time. */
const HIT_INTERVAL_SECONDS = 0.07;

interface ActiveThrow {
  /** seq to hand back to the presenter. */
  seq: number;
  /** Null if planning failed; the dice are then simply seated on their values. */
  plan: ThrowPlan | null;
  indices: readonly number[];
  values: readonly GameDie["value"][];
  /** Playback clock: negative while the dice are being scooped up, then seconds of flight. */
  time: number;
  /** Frame time since the throw started (for the backstop). */
  age: number;
  startedAt: number;
  nextHit: number;
  lastHitAt: number[];
}

interface Seen {
  phase: Phase | null;
  dice: readonly GameDie[] | null;
  /** Where each held die rests in the kept lane (null = not held). */
  spots: (Vec3 | null)[];
  snap: number;
}

/**
 * Fired on `window` once per canvas mount, when the physics engine is up and the tray and
 * dice have been drawn: the app keeps its loading screen until then. The canvas element
 * also gets `data-scene-ready="true"`, for anything that starts listening late.
 */
export const SCENE_READY_EVENT = "farkle:scene-ready";
/** Frames drawn with the dice seated before the scene is called ready (shaders compile in the first). */
const READY_AFTER_FRAMES = 2;

const _position = new Vector3();
const _rotation = new Quaternion();
const _scratch = new Quaternion();

/**
 * The six dice, driven by the presented game.
 *
 * Dice values come from the game log, never from the physics here: when the presenter has a
 * pending throw, the throw is simulated up front (see throwSim), re-oriented so every die
 * ends on its logged value, and played back; then the presenter is told it has settled.
 * Anything else (opening a game, Skip, catching up) seats the dice straight from context.
 *
 * All flow control lives in one frame loop that compares the current game state with the
 * last one it acted on, so StrictMode's doubled effects can't start or settle a throw twice.
 */
export function DiceSet() {
  const actor = useGameActor();
  const sendIntent = useGameIntent();
  const throwSettled = useThrowSettled();
  const { rapier } = useRapier();

  // The frame loop reads the latest presenter view through refs.
  const pendingThrow = usePendingThrow();
  const pendingRef = useRef(pendingThrow);
  pendingRef.current = pendingThrow;
  const snapCount = useSnapCount();
  const snapRef = useRef(snapCount);
  snapRef.current = snapCount;
  const canAct = useCanAct();
  const canActRef = useRef(canAct);
  canActRef.current = canAct;

  const handles = useRef<(DieHandle | null)[]>([]);
  const seen = useRef<Seen>({ phase: null, dice: null, spots: [], snap: 0 });
  const canvas = useThree((state) => state.gl.domElement);
  /** Frames drawn since the dice were first seated; null once the ready event has been sent. */
  const framesDrawn = useRef<number | null>(0);
  const active = useRef<ActiveThrow | null>(null);
  /** seq of the last throw started, so a throw is never animated twice. */
  const startedSeq = useRef<number | null>(null);

  // Render-side state: only what the dice need for interaction and highlights.
  const phase = useGameSelector((snapshot) => phaseOf(snapshot.value));
  const dice = useGameSelector((snapshot) => snapshot.context.dice);
  const selected = useGameSelector((snapshot) => snapshot.context.selected);
  const dividers = useMemo(() => layoutKeptLane(keepGroups(dice)).dividers, [dice]);

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    window.__farkle = actor;
    window.__farkleStats = stats;
    window.__farkleDice = () => DICE.flatMap((i) => handles.current[i]?.read() ?? []);
    return () => {
      if (window.__farkle === actor) delete window.__farkle;
    };
  }, [actor]);

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

  // Tapping: rather than requiring a hit on the die mesh itself (small on a phone), a tap
  // goes to the nearest pickable die within a generous on-screen radius.
  const getThree = useThree((state) => state.get);
  const pickableRef = useRef<number[]>([]);
  const onToggleRef = useRef(onToggle);
  onToggleRef.current = onToggle;
  useEffect(() => {
    let down: { id: number; x: number; y: number } | null = null;
    const center = new Vector3();
    const edge = new Vector3();
    const right = new Vector3();
    const onDown = (event: PointerEvent) => {
      down = event.isPrimary && event.button === 0 ? { id: event.pointerId, x: event.clientX, y: event.clientY } : null;
    };
    const onCancel = () => {
      down = null;
    };
    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || start.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > tapSlop(event.pointerType)) return;
      const { camera, size } = getThree();
      const rect = canvas.getBoundingClientRect();
      right.setFromMatrixColumn(camera.matrixWorld, 0).multiplyScalar((DIE_SIZE * DIE_DISPLAY_SCALE) / 2);
      const toScreen = (v: Vector3) => {
        v.project(camera);
        return [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height] as const;
      };
      const onScreen: ScreenDie[] = pickableRef.current.flatMap((index) => {
        const handle = handles.current[index];
        if (!handle?.ready()) return [];
        const [x, y] = toScreen(center.set(...handle.read().position));
        const [ex, ey] = toScreen(edge.set(...handle.read().position).add(right));
        return [{ index, x, y, radius: Math.hypot(ex - x, ey - y) }];
      });
      const index = pickDie(event.clientX - rect.left, event.clientY - rect.top, onScreen);
      if (index !== null) onToggleRef.current(index);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
    };
  }, [canvas, getThree]);

  useFrame((_, rawDelta) => {
    const all = handles.current;
    if (DICE.some((i) => !all[i]?.ready())) return;
    const die = (i: number) => all[i]!;

    const snapshot = actor.getSnapshot();
    const context: GameContext = snapshot.context;
    const now = phaseOf(snapshot.value);
    const last = seen.current;
    const pending = pendingRef.current;
    const snap = snapRef.current;

    // Each pass through here after the first means one more frame has been drawn.
    if (last.phase !== null && framesDrawn.current !== null && ++framesDrawn.current > READY_AFTER_FRAMES) {
      framesDrawn.current = null;
      canvas.dataset.sceneReady = "true";
      window.dispatchEvent(new Event(SCENE_READY_EVENT));
    }

    // --- 1. keep the resting dice in step with the game state ---------------------------
    const first = last.phase === null;
    const snapped = snap !== last.snap;
    if (first || snapped || now !== last.phase || context.dice !== last.dice) {
      const spots = layoutKeptLane(keepGroups(context.dice)).positions;

      if (first || snapped) {
        // Opening a game, Skip, or a catch-up jump: no animation, just put every die where
        // the game says it is, showing its value. Any throw in progress is abandoned.
        active.current = null;
        DICE.forEach((i) => {
          const spot = spots[i] ?? null;
          const value = context.dice[i]?.value ?? null;
          die(i).place(
            spot ?? readyPosition(i),
            value !== null ? faceUpQuaternion(value) : "square",
          );
        });
      } else {
        DICE.forEach((i) => {
          const spot = spots[i] ?? null;
          const was = last.spots[i] ?? null;
          const value = context.dice[i]?.value ?? null;
          const shown = die(i).read();
          const wrongFace = value !== null && !shown.gliding && shown.value !== value;
          if (spot !== null && was === null) {
            // Newly kept dice hop over the divider into the lane, next to the rest of their keep.
            die(i).glideTo(spot, {
              orientation: wrongFace ? faceUpQuaternion(value) : "square",
              duration: 0.45,
              arc: 1.1,
            });
          } else if (spot !== null && was !== null && spot[0] !== was[0]) {
            // Earlier keeps slide along the felt to make room for the new group.
            die(i).glideTo(spot, {
              orientation: wrongFace ? faceUpQuaternion(value) : "square",
              duration: 0.45,
              arc: 0,
            });
          } else if (wrongFace && active.current === null) {
            // Safety net: the state moved on without a throw we animated. Show the truth.
            stats.reseats += 1;
            die(i).place(spot ?? readyPosition(i), faceUpQuaternion(value));
          }
        });
        if (now === "awaitingRoll" && last.phase !== "awaitingRoll") {
          // New turn: gather the dice into the waiting row.
          DICE.forEach((i) => {
            if (spots[i] == null) die(i).glideTo(readyPosition(i), { orientation: "square", duration: 0.5, arc: 0.9 });
          });
        }
      }
      seen.current = { phase: now, dice: context.dice, spots, snap };
    }

    // --- 2. start the pending throw (once) -------------------------------------------------
    let thrown = active.current;
    if (thrown && pending?.seq !== thrown.seq) {
      // The presenter moved on without us (Skip is handled above; this is belt and braces).
      thrown = active.current = null;
    }
    if (pending && !thrown && pending.seq !== startedSeq.current) {
      startedSeq.current = pending.seq;
      stats.throws += 1;
      let plan: ThrowPlan | null = null;
      const planStart = performance.now();
      try {
        plan = planThrow(rapier, pending.indices, pending.values);
        stats.simulations += plan.attempts;
        if (!plan.clean) stats.unclean += 1;
      } catch (error) {
        // Never let a simulation failure block the game: the dice are seated instead.
        stats.fallbacks += 1;
        if (import.meta.env.DEV) console.warn("Throw simulation failed", error);
      }
      stats.lastPlanMs = performance.now() - planStart;
      stats.maxPlanMs = Math.max(stats.maxPlanMs, stats.lastPlanMs);

      if (plan) {
        // Scoop the dice up into the "hand": the first pose of the recording.
        pending.indices.forEach((index, n) => {
          samplePlan(plan, n, 0, _position, _rotation, _scratch);
          die(index).glideTo([_position.x, _position.y, _position.z], {
            orientation: _rotation,
            duration: SCOOP_SECONDS,
            arc: 0.5,
          });
        });
      }
      thrown = active.current = {
        seq: pending.seq,
        plan,
        indices: pending.indices,
        values: pending.values,
        time: plan ? -SCOOP_SECONDS : 0,
        age: 0,
        startedAt: performance.now(),
        nextHit: 0,
        lastHitAt: pending.indices.map(() => -1),
      };
    }
    if (!thrown) return;

    // --- 3. play the throw back, then report it ----------------------------------------
    thrown.age += Math.min(rawDelta, 0.25);
    const held = import.meta.env.DEV && stats.holdSettle;
    if (!held) thrown.time += Math.min(rawDelta, 0.1);
    const { plan } = thrown;
    const timedOut = thrown.age >= HARD_TIMEOUT_SECONDS;
    const finished = plan === null || thrown.time >= plan.duration;

    if (plan && !finished && !timedOut) {
      if (thrown.time < 0 || held) return; // still being scooped up
      thrown.indices.forEach((index, n) => {
        samplePlan(plan, n, thrown.time, _position, _rotation, _scratch);
        die(index).track(_position, _rotation);
      });
      while (thrown.nextHit < plan.hits.length && plan.hits[thrown.nextHit]!.time <= thrown.time) {
        const hit = plan.hits[thrown.nextHit++]!;
        if (hit.time - (thrown.lastHitAt[hit.die] ?? -1) < HIT_INTERVAL_SECONDS) continue;
        thrown.lastHitAt[hit.die] = hit.time;
        playDiceHit(hit.strength, hit.surface);
      }
      return;
    }

    // Final poses, exactly. For a played-out throw this is where the dice already are.
    thrown.indices.forEach((index, n) => {
      const value = thrown.values[n] ?? null;
      if (plan) {
        samplePlan(plan, n, plan.duration, _position, _rotation, _scratch);
        die(index).place(_position, _rotation);
      } else if (value !== null) {
        die(index).place(readyPosition(index), faceUpQuaternion(value));
      }
    });
    if (thrown.indices.some((index, n) => die(index).read().value !== thrown.values[n])) stats.mismatches += 1;
    if (timedOut && !finished) stats.forced += 1;
    stats.settled += 1;
    stats.lastSettleMs = performance.now() - thrown.startedAt;
    stats.maxSettleMs = Math.max(stats.maxSettleMs, stats.lastSettleMs);
    active.current = null;
    throwSettled(thrown.seq);
  });

  const isPickable = (i: number) => {
    const state = dice[i];
    return canAct && phase === "choosing" && !!state && !state.held && state.value !== null;
  };
  pickableRef.current = DICE.filter(isPickable);

  return (
    <>
      <KeptLaneMarks dividers={dividers} />
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
            interactive={isPickable(i)}
            selected={phase === "choosing" && selected.includes(i)}
            dimmed={phase === "farkled" && free}
          />
        );
      })}
    </>
  );
}
