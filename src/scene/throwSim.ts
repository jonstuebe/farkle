/**
 * Throws whose outcome is decided before they are shown.
 *
 * Dice values come from the game log, so the scene can't let live physics pick the faces.
 * Instead each throw is simulated up front in a throw-away, headless Rapier world (same
 * tray, same dice, same launch as before), recorded, and then every die is re-oriented by
 * a cube symmetry so the face that physically lands on top is the face the log asked for.
 * The scene just plays the recording back: real tumbling, guaranteed result, no snap.
 *
 * No React or rendering in here; the Rapier module is passed in so this runs in tests too.
 */
import { Euler, Quaternion, Vector3 } from "three";
import type { useRapier } from "@react-three/rapier";
import { DIE_RADIUS, DIE_SIZE, topFace, topFaceAlignment, type DieValue } from "./dice";
import { faceRemapQuaternion, impactStrength, isCocked, levelQuaternion, makeThrow, REST_Y, type Throw } from "./diceLayout";
import { GRAVITY, TRAY_COLLIDERS } from "./tray";

export type RapierModule = ReturnType<typeof useRapier>["rapier"];

/** Die body tuning. Values are paired with GRAVITY in ./tray. */
export const DIE_PHYSICS = {
  /** Resin on felt: grippy enough to roll rather than slide, without tripping over. */
  friction: 0.42,
  /** Lively first bounce that dies out within two or three hops. */
  restitution: 0.32,
  /** Bleeds off the long, slow final wobble without making the flight look floaty. */
  linearDamping: 0.12,
  angularDamping: 0.28,
  /** Relative weight only (nothing else is dynamic), kept ~1 for solver stability. */
  density: 1.2,
} as const;

export const SIM_STEP = 1 / 60;
/** A die counts as still below both of these speeds... */
const STILL_LINEAR_SPEED = 0.06;
const STILL_ANGULAR_SPEED = 0.12;
/** ...and the throw is over once every die has been still for this many steps. */
const STILL_STEPS = 12;
/** Throws that take longer than this to come to rest are thrown again. */
export const MAX_FLIGHT_SECONDS = 3.4;
const MAX_STEPS = Math.round(MAX_FLIGHT_SECONDS / SIM_STEP);
/** How many throws may be tried to find one where every die lands flat on the felt. */
export const MAX_ATTEMPTS = 24;
/** Steps used to ease a still-leaning die flat when no clean throw was found. */
const LEVEL_STEPS = 14;

/** Floats per recorded pose: position xyz + quaternion xyzw. */
export const POSE_SIZE = 7;

export interface Hit {
  /** Seconds after release. */
  time: number;
  /** Position of the die within the throw (0 = first thrown). */
  die: number;
  /** 0..1, see impactStrength. */
  strength: number;
  surface: "felt" | "wood" | "die";
}

/** One simulated throw, as it physically happened. */
export interface Flight {
  launches: Throw[];
  /** Recorded steps, including the launch pose at step 0. */
  steps: number;
  /** Per die: `steps * POSE_SIZE` floats. */
  poses: Float32Array[];
  /** The face each die physically ended on. */
  landed: DieValue[];
  hits: Hit[];
  /** Every die came to rest in time, flat on the felt. */
  clean: boolean;
}

/** A throw ready to play back: poses already show the requested values. */
export interface ThrowPlan {
  /** Die index per thrown die (ascending), and the value each one ends on. */
  indices: number[];
  values: DieValue[];
  /** Seconds from release to rest. */
  duration: number;
  steps: number;
  poses: Float32Array[];
  hits: Hit[];
  /** How many simulations it took, and whether the one used was clean. */
  attempts: number;
  clean: boolean;
}

const CORE = DIE_SIZE / 2 - DIE_RADIUS;

/** Simulate one throw of `count` dice to rest and record it. */
export function simulateFlight(rapier: RapierModule, count: number, random: () => number = Math.random): Flight {
  const world = new rapier.World({ x: GRAVITY[0], y: GRAVITY[1], z: GRAVITY[2] });
  try {
    world.timestep = SIM_STEP;
    for (const collider of TRAY_COLLIDERS) {
      const [hx, hy, hz] = collider.halfExtents;
      const [x, y, z] = collider.position;
      world.createCollider(
        rapier.ColliderDesc.cuboid(hx, hy, hz)
          .setTranslation(x, y, z)
          .setFriction(collider.friction)
          .setRestitution(collider.restitution),
      );
    }

    const launches = Array.from({ length: count }, (_, n) => makeThrow(n, count, random));
    const dieOf = new Map<number, number>();
    const colliders: ReturnType<typeof world.createCollider>[] = [];
    const bodies = launches.map((launch, n) => {
      const q = new Quaternion().setFromEuler(new Euler(...launch.rotation));
      const [px, py, pz] = launch.position;
      const [vx, vy, vz] = launch.linearVelocity;
      const [wx, wy, wz] = launch.angularVelocity;
      const body = world.createRigidBody(
        rapier.RigidBodyDesc.dynamic()
          .setTranslation(px, py, pz)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setLinvel(vx, vy, vz)
          .setAngvel({ x: wx, y: wy, z: wz })
          .setLinearDamping(DIE_PHYSICS.linearDamping)
          .setAngularDamping(DIE_PHYSICS.angularDamping)
          .setCcdEnabled(true),
      );
      const collider = world.createCollider(
        rapier.ColliderDesc.roundCuboid(CORE, CORE, CORE, DIE_RADIUS)
          .setFriction(DIE_PHYSICS.friction)
          .setRestitution(DIE_PHYSICS.restitution)
          .setDensity(DIE_PHYSICS.density),
        body,
      );
      dieOf.set(collider.handle, n);
      colliders.push(collider);
      return body;
    });

    const poses = bodies.map(() => new Float32Array((MAX_STEPS + 1) * POSE_SIZE));
    const record = (step: number) => {
      bodies.forEach((body, n) => {
        const t = body.translation();
        const r = body.rotation();
        poses[n]!.set([t.x, t.y, t.z, r.x, r.y, r.z, r.w], step * POSE_SIZE);
      });
    };
    record(0);

    const hits: Hit[] = [];
    const gravity = new Vector3(...GRAVITY);
    const before = bodies.map(() => new Vector3());
    const jolt = bodies.map(() => new Vector3());
    let stillSteps = 0;
    let steps = 1;
    let rested = false;
    for (let step = 1; step <= MAX_STEPS; step++) {
      bodies.forEach((body, n) => {
        const v = body.linvel();
        before[n]!.set(v.x, v.y, v.z);
      });
      world.step();
      record(step);
      steps = step + 1;

      // Impacts: how much each die's velocity changed beyond what gravity alone would do.
      const jolts = bodies.map((body, n) => {
        const v = body.linvel();
        return jolt[n]!.set(v.x, v.y, v.z).sub(before[n]!).addScaledVector(gravity, -SIM_STEP).length();
      });
      bodies.forEach((_, n) => {
        const strength = impactStrength(jolts[n]!);
        if (strength <= 0) return;
        // Hit another die that was jolted too? The lower-numbered die reports the pair.
        let partner = -1;
        world.contactPairsWith(colliders[n]!, (other) => {
          const die = dieOf.get(other.handle);
          if (die !== undefined && impactStrength(jolts[die]!) > 0) partner = partner < 0 ? die : Math.min(partner, die);
        });
        if (partner >= 0 && partner < n) return;
        const surface = partner >= 0 ? "die" : Math.abs(jolt[n]!.y) > 0.7 * jolts[n]! ? "felt" : "wood";
        hits.push({ time: step * SIM_STEP, die: n, strength, surface });
      });

      const still = bodies.every((body) => {
        if (body.isSleeping()) return true;
        const v = body.linvel();
        const w = body.angvel();
        return Math.hypot(v.x, v.y, v.z) < STILL_LINEAR_SPEED && Math.hypot(w.x, w.y, w.z) < STILL_ANGULAR_SPEED;
      });
      stillSteps = still ? stillSteps + 1 : 0;
      if (stillSteps >= STILL_STEPS) {
        rested = true;
        break;
      }
    }

    const landed = bodies.map((body) => topFace(body.rotation()));
    const flat = bodies.every((body) => !isCocked(topFaceAlignment(body.rotation()), body.translation().y));
    return {
      launches,
      steps,
      poses: poses.map((p) => p.subarray(0, steps * POSE_SIZE)),
      landed,
      hits,
      clean: rested && flat,
    };
  } finally {
    world.free();
  }
}

/** Append frames that ease every die from its last pose to lying flat (last resort). */
function levelOff(flight: Flight): Flight {
  const from = new Quaternion();
  const q = new Quaternion();
  const poses = flight.poses.map((recorded) => {
    const last = (flight.steps - 1) * POSE_SIZE;
    const out = new Float32Array((flight.steps + LEVEL_STEPS) * POSE_SIZE);
    out.set(recorded);
    from.set(recorded[last + 3]!, recorded[last + 4]!, recorded[last + 5]!, recorded[last + 6]!);
    const y = recorded[last + 1]!;
    // A die sitting on another die keeps its height; one on the felt is pressed flat.
    const onFelt = y < REST_Y + 0.2;
    const to = levelQuaternion(from);
    for (let i = 1; i <= LEVEL_STEPS; i++) {
      const t = i / LEVEL_STEPS;
      const k = t * t * (3 - 2 * t);
      q.slerpQuaternions(from, to, k);
      out.set(
        [recorded[last]!, onFelt ? y + (REST_Y - y) * k : y, recorded[last + 2]!, q.x, q.y, q.z, q.w],
        (flight.steps - 1 + i) * POSE_SIZE,
      );
    }
    return out;
  });
  return { ...flight, poses, steps: flight.steps + LEVEL_STEPS };
}

/** Re-orient a recorded flight so each die ends on its target value. */
export function remapFlight(flight: Flight, values: readonly DieValue[]): Float32Array[] {
  const q = new Quaternion();
  return flight.poses.map((recorded, n) => {
    const target = values[n];
    const landed = flight.landed[n];
    if (target === undefined || landed === undefined || target === landed) return recorded;
    const remap = faceRemapQuaternion(landed, target);
    const out = new Float32Array(recorded);
    for (let o = 0; o < out.length; o += POSE_SIZE) {
      q.set(out[o + 3]!, out[o + 4]!, out[o + 5]!, out[o + 6]!).multiply(remap);
      out[o + 3] = q.x;
      out[o + 4] = q.y;
      out[o + 5] = q.z;
      out[o + 6] = q.w;
    }
    return out;
  });
}

/**
 * Plan a throw of dice `indices` that ends showing `values` (same order). Simulates until a
 * throw lands with every die flat on the felt (almost always the first or second try).
 */
export function planThrow(
  rapier: RapierModule,
  indices: readonly number[],
  values: readonly DieValue[],
  random: () => number = Math.random,
): ThrowPlan {
  let flight = simulateFlight(rapier, indices.length, random);
  let attempts = 1;
  while (!flight.clean && attempts < MAX_ATTEMPTS) {
    flight = simulateFlight(rapier, indices.length, random);
    attempts++;
  }
  const clean = flight.clean;
  if (!clean) flight = levelOff(flight);
  return {
    indices: [...indices],
    values: [...values],
    duration: (flight.steps - 1) * SIM_STEP,
    steps: flight.steps,
    poses: remapFlight(flight, values),
    hits: flight.hits,
    attempts,
    clean,
  };
}

/** Pose of thrown die `n` at `time` seconds after release (clamped to the recording). */
export function samplePlan(
  plan: Pick<ThrowPlan, "poses" | "steps">,
  n: number,
  time: number,
  position: { set(x: number, y: number, z: number): void },
  rotation: Quaternion,
  scratch: Quaternion = new Quaternion(),
): void {
  const poses = plan.poses[n];
  if (!poses) return;
  const f = Math.min(Math.max(time / SIM_STEP, 0), plan.steps - 1);
  const i = Math.min(Math.floor(f), plan.steps - 1);
  const j = Math.min(i + 1, plan.steps - 1);
  const k = f - i;
  const a = i * POSE_SIZE;
  const b = j * POSE_SIZE;
  const mix = (o: number) => poses[a + o]! + (poses[b + o]! - poses[a + o]!) * k;
  position.set(mix(0), mix(1), mix(2));
  rotation.set(poses[a + 3]!, poses[a + 4]!, poses[a + 5]!, poses[a + 6]!);
  scratch.set(poses[b + 3]!, poses[b + 4]!, poses[b + 5]!, poses[b + 6]!);
  rotation.slerp(scratch, k);
}
