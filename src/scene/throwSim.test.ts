import { beforeAll, describe, expect, it } from "vitest";
import RAPIER from "@dimforge/rapier3d-compat";
import { Quaternion, Vector3 } from "three";
import { DIE_SIZE, topFace, topFaceAlignment, type DieValue } from "./dice";
import { COCKED_ALIGNMENT, REST_Y } from "./diceLayout";
import { MAX_FLIGHT_SECONDS, planThrow, POSE_SIZE, samplePlan, SIM_STEP, simulateFlight, type RapierModule } from "./throwSim";
import { PLAY_MAX_Z, PLAY_MIN_Z, TRAY_WIDTH } from "./tray";

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
// SAFETY: the scene gets this same module from useRapier(); the package is the one @react-three/rapier wraps.
const rapier = RAPIER as unknown as RapierModule;

beforeAll(async () => {
  await RAPIER.init();
});

const finalPose = (poses: Float32Array, steps: number) => {
  const o = (steps - 1) * POSE_SIZE;
  return {
    position: new Vector3(poses[o]!, poses[o + 1]!, poses[o + 2]!),
    rotation: new Quaternion(poses[o + 3]!, poses[o + 4]!, poses[o + 5]!, poses[o + 6]!),
  };
};

describe("simulateFlight", () => {
  it("is reproducible for the same random sequence", () => {
    const a = simulateFlight(rapier, 6, lcg(5));
    const b = simulateFlight(rapier, 6, lcg(5));
    expect(a.steps).toBe(b.steps);
    expect(a.landed).toEqual(b.landed);
    expect(Array.from(a.poses[3]!)).toEqual(Array.from(b.poses[3]!));
  });

  it("starts at the launch pose and records impacts in time order", () => {
    const flight = simulateFlight(rapier, 4, lcg(11));
    flight.launches.forEach((launch, n) => {
      expect(flight.poses[n]![0]).toBeCloseTo(launch.position[0], 5);
      expect(flight.poses[n]![1]).toBeCloseTo(launch.position[1], 5);
    });
    expect(flight.hits.length).toBeGreaterThan(3);
    expect(flight.hits.some((hit) => hit.surface === "felt")).toBe(true);
    flight.hits.forEach((hit, i) => {
      expect(hit.strength).toBeGreaterThan(0);
      expect(hit.strength).toBeLessThanOrEqual(1);
      expect(hit.die).toBeLessThan(4);
      if (i > 0) expect(hit.time).toBeGreaterThanOrEqual(flight.hits[i - 1]!.time);
    });
  });
});

describe("planThrow", () => {
  it("always ends on the requested values, flat, inside the play area, in time", () => {
    const random = lcg(2024);
    let throws = 0;
    let worstAttempts = 0;
    let longest = 0;
    let unclean = 0;
    for (let round = 0; round < 60; round++) {
      const count = 1 + (round % 6);
      const indices = [0, 1, 2, 3, 4, 5].slice(6 - count);
      const values = indices.map(() => (1 + Math.floor(random() * 6)) as DieValue);
      const plan = planThrow(rapier, indices, values, random);
      throws++;
      worstAttempts = Math.max(worstAttempts, plan.attempts);
      longest = Math.max(longest, plan.duration);
      if (!plan.clean) unclean++;
      expect(plan.poses).toHaveLength(count);
      expect(plan.duration).toBeLessThanOrEqual(MAX_FLIGHT_SECONDS + 0.3);
      const ends = plan.poses.map((poses) => finalPose(poses, plan.steps));
      ends.forEach(({ position, rotation }, n) => {
        expect(topFace(rotation)).toBe(values[n]);
        expect(topFaceAlignment(rotation)).toBeGreaterThanOrEqual(COCKED_ALIGNMENT);
        expect(Math.abs(position.x)).toBeLessThan(TRAY_WIDTH / 2);
        expect(position.z).toBeGreaterThan(PLAY_MIN_Z);
        expect(position.z).toBeLessThan(PLAY_MAX_Z);
        if (plan.clean) expect(position.y).toBeLessThan(REST_Y + 0.2);
      });
      // Resting dice don't overlap.
      if (plan.clean) {
        ends.forEach((a, i) => ends.slice(i + 1).forEach((b) => expect(a.position.distanceTo(b.position)).toBeGreaterThan(DIE_SIZE * 0.98)));
      }
    }
    expect(throws).toBe(60);
    expect(unclean).toBe(0);
    console.log(`planThrow: 60 throws, worst attempts ${worstAttempts}, longest flight ${longest.toFixed(2)}s`);
  });

  it("moves continuously: no jump between consecutive recorded steps", () => {
    const plan = planThrow(rapier, [0, 1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6], lcg(77));
    const a = new Quaternion();
    const b = new Quaternion();
    for (const poses of plan.poses) {
      for (let step = 1; step < plan.steps; step++) {
        const o = step * POSE_SIZE;
        const p = o - POSE_SIZE;
        const moved = Math.hypot(poses[o]! - poses[p]!, poses[o + 1]! - poses[p + 1]!, poses[o + 2]! - poses[p + 2]!);
        expect(moved).toBeLessThan(0.5); // < 30 units/s
        a.set(poses[p + 3]!, poses[p + 4]!, poses[p + 5]!, poses[p + 6]!);
        b.set(poses[o + 3]!, poses[o + 4]!, poses[o + 5]!, poses[o + 6]!);
        expect(a.angleTo(b)).toBeLessThan(0.8); // < ~48 rad/s
      }
    }
  });

  it("samples between steps and clamps at both ends", () => {
    const plan = planThrow(rapier, [2, 5], [6, 1], lcg(3));
    const position = new Vector3();
    const rotation = new Quaternion();
    samplePlan(plan, 0, -1, position, rotation);
    expect(position.y).toBeCloseTo(plan.poses[0]![1]!, 6);
    samplePlan(plan, 1, 999, position, rotation);
    expect(topFace(rotation)).toBe(1);
    const end = finalPose(plan.poses[1]!, plan.steps);
    expect(position.distanceTo(end.position)).toBeCloseTo(0, 6);
    samplePlan(plan, 0, SIM_STEP * 10.5, position, rotation);
    const y10 = plan.poses[0]![10 * POSE_SIZE + 1]!;
    const y11 = plan.poses[0]![11 * POSE_SIZE + 1]!;
    expect(position.y).toBeCloseTo((y10 + y11) / 2, 6);
    expect(rotation.length()).toBeCloseTo(1, 6);
  });
});
