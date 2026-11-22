import { describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";
import { FACE_NORMALS, topFace, topFaceAlignment } from "./dice";
import {
  assignHeldSlots,
  faceRemapQuaternion,
  faceUpQuaternion,
  heldSlotPosition,
  impactStrength,
  isCocked,
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

describe("held slots", () => {
  it("fills slots left to right in index order", () => {
    expect(assignHeldSlots([], [false, true, false, true, true, false])).toEqual([null, 0, null, 1, 2, null]);
  });

  it("keeps earlier dice where they are when more are held", () => {
    const first = assignHeldSlots(Array(6).fill(null), [false, false, false, true, false, true]);
    expect(first).toEqual([null, null, null, 0, null, 1]);
    expect(assignHeldSlots(first, [true, false, true, true, false, true])).toEqual([2, null, 3, 0, null, 1]);
  });

  it("frees every slot on a reset (new turn / hot dice)", () => {
    expect(assignHeldSlots([0, 1, 2, 3, 4, 5], Array(6).fill(false))).toEqual(Array(6).fill(null));
  });

  it("reuses a freed slot", () => {
    expect(assignHeldSlots([0, 1, null], [false, true, true])).toEqual([null, 1, 0]);
  });

  it("places slots inside the lane, apart from each other, flat on the felt", () => {
    const half = DIE_SIZE / 2;
    for (let slot = 0; slot < 6; slot++) {
      const [x, y, z] = heldSlotPosition(slot);
      expect(y).toBe(REST_Y);
      expect(Math.abs(x) + half).toBeLessThan(TRAY_WIDTH / 2);
      expect(z - half).toBeGreaterThan(DIVIDER_Z + 0.07);
      expect(z + half).toBeLessThan(TRAY_DEPTH / 2);
      if (slot > 0) expect(x - heldSlotPosition(slot - 1)[0]).toBeGreaterThan(DIE_SIZE);
    }
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
