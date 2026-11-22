import { describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";
import { FACE_NORMALS, topFace, topFaceAlignment } from "./dice";
import {
  faceRemapQuaternion,
  faceUpQuaternion,
  impactStrength,
  isCocked,
  keepGroups,
  KEPT_GROUP_PITCH,
  KEPT_PITCH,
  layoutKeptLane,
  levelQuaternion,
  makeThrow,
  phaseOf,
  readyPosition,
  REST_Y,
  squareUpQuaternion,
} from "./diceLayout";
import { DIVIDER_Z, PLAY_MAX_Z, PLAY_MIN_Z, TRAY_DEPTH, TRAY_WIDTH } from "./tray";
import { DIE_SIZE } from "./dice";

const lcg = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;

describe("kept lane", () => {
  const xs = (keeps: (number | null)[]) => layoutKeptLane(keeps).positions.map((p) => (p ? Math.round(p[0] * 1000) / 1000 : null));
  /** Every way to split six held dice into keeps (each die's keep, non-decreasing labels not required). */
  const everySplit = (): number[][] => {
    const out: number[][] = [];
    const walk = (prefix: number[], groups: number) => {
      if (prefix.length === 6) return void out.push(prefix);
      for (let keep = 0; keep <= groups; keep++) walk([...prefix, keep], Math.max(groups, keep + 1));
    };
    walk([], 0);
    return out;
  };

  it("leaves dice that aren't held out", () => {
    expect(layoutKeptLane(Array(6).fill(null))).toEqual({ positions: Array(6).fill(null), dividers: [] });
    expect(xs([null, 0, null, null, null, null])).toEqual([null, 0, null, null, null, null]);
  });

  it("puts dice kept together shoulder to shoulder, centred, in index order", () => {
    expect(xs([null, 0, null, 0, 0, null])).toEqual([null, -KEPT_PITCH, null, 0, KEPT_PITCH, null]);
    expect(layoutKeptLane([null, 0, null, 0, 0, null]).dividers).toEqual([]);
  });

  it("orders groups oldest keep first, whatever the dice indices", () => {
    // Die 5 was kept first, then dice 0 and 2, then die 3.
    const { positions, dividers } = layoutKeptLane([1, null, 1, 2, null, 0]);
    const x = (i: number) => positions[i]![0];
    expect(x(5)).toBeLessThan(x(0));
    expect(x(0)).toBeLessThan(x(2));
    expect(x(2)).toBeLessThan(x(3));
    expect(x(2) - x(0)).toBeCloseTo(KEPT_PITCH, 9);
    expect(x(0) - x(5)).toBeCloseTo(KEPT_GROUP_PITCH, 9);
    expect(x(3) - x(2)).toBeCloseTo(KEPT_GROUP_PITCH, 9);
    expect(dividers).toHaveLength(2);
    expect(dividers[0]).toBeCloseTo((x(5) + x(0)) / 2, 9);
    expect(dividers[1]).toBeCloseTo((x(2) + x(3)) / 2, 9);
  });

  it("three 5s kept over three rolls are three separate groups, not a set", () => {
    const apart = layoutKeptLane([0, 1, 2, null, null, null]);
    const together = layoutKeptLane([0, 0, 0, null, null, null]);
    expect(apart.dividers).toHaveLength(2);
    expect(together.dividers).toHaveLength(0);
    const gap = (lane: typeof apart) => lane.positions[1]![0] - lane.positions[0]![0] - DIE_SIZE;
    expect(gap(together)).toBeLessThan(DIE_SIZE * 0.2);
    expect(gap(apart)).toBeGreaterThan(DIE_SIZE * 0.75);
  });

  it("keeps earlier groups in order and intact when another keep joins", () => {
    const before = layoutKeptLane([0, 0, null, null, 1, null]).positions;
    const after = layoutKeptLane([0, 0, 2, null, 1, 2]).positions;
    for (const [a, b] of [[0, 1], [1, 4]] as const) {
      expect(after[b]![0] - after[a]![0]).toBeCloseTo(before[b]![0] - before[a]![0], 9);
    }
    // Everything already there slides the same way by the same amount.
    expect(after[0]![0] - before[0]![0]).toBeCloseTo(after[4]![0] - before[4]![0], 9);
    expect(after[2]![0]).toBeGreaterThan(after[4]![0]);
  });

  it("keep numbers needn't start at zero (after hot dice)", () => {
    expect(xs([3, 3, null, 4, null, null])).toEqual(xs([0, 0, null, 1, null, null]));
  });

  it("fits six dice in any grouping, up to six groups: inside the lane, never overlapping", () => {
    const half = DIE_SIZE / 2;
    const splits = everySplit();
    expect(splits).toHaveLength(203); // Bell number B6
    for (const split of splits) {
      const { positions, dividers } = layoutKeptLane(split);
      const sorted = positions.map((p) => p!).sort((a, b) => a[0] - b[0]);
      expect(dividers).toHaveLength(new Set(split).size - 1);
      sorted.forEach(([x, y, z], n) => {
        expect(y).toBe(REST_Y);
        expect(Math.abs(x) + half).toBeLessThan(TRAY_WIDTH / 2 - 0.2);
        expect(z - half).toBeGreaterThan(DIVIDER_Z + 0.07);
        expect(z + half).toBeLessThan(TRAY_DEPTH / 2);
        if (n > 0) expect(x - sorted[n - 1]![0]).toBeGreaterThan(DIE_SIZE);
      });
      // Centred.
      expect(sorted[0]![0] + sorted[5]![0]).toBeCloseTo(0, 9);
    }
  });

  it("reads each die's group from the game state", () => {
    expect(
      keepGroups([
        { held: true, keep: 2 },
        { held: false, keep: null },
        { held: true, keep: 0 },
        { held: true }, // a save from before keeps were recorded
      ]),
    ).toEqual([2, null, 0, 0]);
  });

  it("places waiting dice inside the play area, apart from each other", () => {
    for (let i = 0; i < 6; i++) {
      const [x, , z] = readyPosition(i);
      expect(Math.abs(x) + DIE_SIZE / 2).toBeLessThan(TRAY_WIDTH / 2);
      expect(z).toBeGreaterThan(PLAY_MIN_Z + 1);
      expect(z).toBeLessThan(PLAY_MAX_Z - 1);
      if (i > 0) expect(x - readyPosition(i - 1)[0]).toBeGreaterThan(DIE_SIZE);
    }
  });
});

describe("pose helpers", () => {
  const rnd = lcg(7);
  const randomQuaternion = () =>
    new Quaternion(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize();

  it("levels a tilted die without changing its top face", () => {
    for (let i = 0; i < 200; i++) {
      const q = randomQuaternion();
      const level = levelQuaternion(q);
      expect(topFace(level)).toBe(topFace(q));
      expect(topFaceAlignment(level)).toBeCloseTo(1, 9);
      expect(level.length()).toBeCloseTo(1, 9);
    }
  });

  it("levelling is the smallest correction (a flat die keeps its heading)", () => {
    const flat = new Quaternion().setFromEuler(new Euler(0, 0.7, 0));
    expect(levelQuaternion(flat).angleTo(flat)).toBeCloseTo(0, 9);
  });

  it("squares a die up so every face is axis-aligned", () => {
    for (let i = 0; i < 200; i++) {
      const q = randomQuaternion();
      const square = squareUpQuaternion(q);
      expect(topFace(square)).toBe(topFace(q));
      for (const value of [1, 2, 3, 4, 5, 6] as const) {
        const n = new Vector3(...FACE_NORMALS[value]).applyQuaternion(square);
        expect(Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z))).toBeCloseTo(1, 9);
      }
      // Never turns more than 45 degrees away from the levelled pose.
      expect(square.angleTo(levelQuaternion(q))).toBeLessThanOrEqual(Math.PI / 4 + 1e-9);
    }
  });

  it("seats a die showing any requested value, level and square", () => {
    for (const value of [1, 2, 3, 4, 5, 6] as const) {
      const q = faceUpQuaternion(value);
      expect(topFace(q)).toBe(value);
      expect(topFaceAlignment(q)).toBeCloseTo(1, 9);
      expect(squareUpQuaternion(q).angleTo(q)).toBeCloseTo(0, 6);
    }
  });

  it("remaps any landed face to any target face, for every pair and orientation", () => {
    const values = [1, 2, 3, 4, 5, 6] as const;
    for (const landed of values) {
      for (const target of values) {
        const remap = faceRemapQuaternion(landed, target);
        expect(remap.length()).toBeCloseTo(1, 9);
        // It is a symmetry of the cube: every face normal maps onto a face normal.
        for (const value of values) {
          const n = new Vector3(...FACE_NORMALS[value]).applyQuaternion(remap);
          expect(Math.max(Math.abs(n.x), Math.abs(n.y), Math.abs(n.z))).toBeCloseTo(1, 9);
        }
        // The target's normal ends up where the landed face's normal was.
        const moved = new Vector3(...FACE_NORMALS[target]).applyQuaternion(remap);
        expect(moved.distanceTo(new Vector3(...FACE_NORMALS[landed]))).toBeCloseTo(0, 9);
        // So any body pose that shows `landed` shows `target` once remapped.
        for (let i = 0; i < 20; i++) {
          const yaw = new Quaternion().setFromEuler(new Euler(0.08 * (rnd() - 0.5), rnd() * 7, 0.08 * (rnd() - 0.5)));
          const body = yaw.multiply(faceUpQuaternion(landed));
          expect(topFace(body)).toBe(landed);
          expect(topFace(body.clone().multiply(remap))).toBe(target);
          expect(topFaceAlignment(body.clone().multiply(remap))).toBeCloseTo(topFaceAlignment(body), 9);
        }
      }
    }
    expect(faceRemapQuaternion(4, 4).angleTo(new Quaternion())).toBe(0);
  });

  it("flags leaning and stacked dice as cocked", () => {
    expect(isCocked(1, REST_Y)).toBe(false);
    expect(isCocked(0.999, REST_Y + 0.01)).toBe(false);
    expect(isCocked(0.9, REST_Y)).toBe(true);
    expect(isCocked(1, REST_Y + DIE_SIZE)).toBe(true);
  });
});

describe("makeThrow", () => {
  it("starts every die apart from the others, above the play area", () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      const throws = Array.from({ length: count }, (_, n) => makeThrow(n, count, lcg(n + 1)));
      throws.forEach((t, a) => {
        expect(t.position[1]).toBeGreaterThan(1.5);
        expect(t.position[2]).toBeGreaterThan(PLAY_MIN_Z + 0.8);
        expect(t.position[2]).toBeLessThan(PLAY_MAX_Z - 0.8);
        expect(t.linearVelocity[0]).toBeGreaterThan(0);
        throws.slice(a + 1).forEach((u) => {
          expect(new Vector3(...t.position).distanceTo(new Vector3(...u.position))).toBeGreaterThan(DIE_SIZE);
        });
      });
    }
  });
});

describe("impactStrength", () => {
  it("ignores resting contact and clamps to 0..1", () => {
    expect(impactStrength(0.6)).toBe(0);
    expect(impactStrength(Number.NaN)).toBe(0);
    expect(impactStrength(5)).toBeGreaterThan(0);
    expect(impactStrength(5)).toBeLessThan(1);
    expect(impactStrength(500)).toBe(1);
  });
});

describe("phaseOf", () => {
  it("maps machine state values", () => {
    expect(phaseOf({ playing: "rolling" })).toBe("rolling");
    expect(phaseOf({ playing: "choosing" })).toBe("choosing");
    expect(phaseOf({ playing: "farkled" })).toBe("farkled");
    expect(phaseOf({ playing: "awaitingRoll" })).toBe("awaitingRoll");
    expect(phaseOf("gameOver")).toBe("other");
    expect(phaseOf(undefined)).toBe("other");
  });
});
