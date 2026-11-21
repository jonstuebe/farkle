import { describe, expect, it } from "vitest";
import { Euler, Quaternion, Vector3 } from "three";
import { FACE_NORMALS, FACE_VALUES, PIP_LAYOUT, topFace, topFaceAlignment, type DieValue } from "./dice";

const VALUES: DieValue[] = [1, 2, 3, 4, 5, 6];
const UP = new Vector3(0, 1, 0);

/** Rotation that brings the given face's local normal to world +Y. */
const faceUp = (value: DieValue) =>
  new Quaternion().setFromUnitVectors(new Vector3(...FACE_NORMALS[value]), UP);

describe("die model", () => {
  it("has opposite faces summing to 7", () => {
    for (const value of VALUES) {
      const opposite = (7 - value) as DieValue;
      const sum = new Vector3(...FACE_NORMALS[value]).add(new Vector3(...FACE_NORMALS[opposite]));
      expect(sum.length()).toBe(0);
    }
    // Box-face order is +X,-X,+Y,-Y,+Z,-Z, so each consecutive pair is an opposite pair.
    expect(FACE_VALUES[0] + FACE_VALUES[1]).toBe(7);
    expect(FACE_VALUES[2] + FACE_VALUES[3]).toBe(7);
    expect(FACE_VALUES[4] + FACE_VALUES[5]).toBe(7);
    expect([...FACE_VALUES].sort()).toEqual(VALUES);
  });

  it("keeps FACE_VALUES and FACE_NORMALS consistent", () => {
    const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    FACE_VALUES.forEach((value, i) => expect([...FACE_NORMALS[value]]).toEqual(axes[i]));
  });

  it("is a right-handed die: 1, 2, 3 run counter-clockwise around their corner", () => {
    const [n1, n2, n3] = ([1, 2, 3] as const).map((v) => new Vector3(...FACE_NORMALS[v]));
    expect(n1!.clone().cross(n2!).dot(n3!)).toBe(1);
  });

  it("draws as many pips as the face value", () => {
    for (const value of VALUES) expect(PIP_LAYOUT[value]).toHaveLength(value);
  });
});

describe("topFace", () => {
  it("reads the identity orientation as the +Y face", () => {
    expect(topFace(new Quaternion())).toBe(3);
  });

  it("returns each face when it points up", () => {
    for (const value of VALUES) expect(topFace(faceUp(value))).toBe(value);
  });

  it("ignores spin about the vertical axis", () => {
    for (const value of VALUES) {
      for (let i = 0; i < 16; i++) {
        const yaw = new Quaternion().setFromAxisAngle(UP, (i / 16) * Math.PI * 2 + 0.123);
        expect(topFace(yaw.multiply(faceUp(value)))).toBe(value);
      }
    }
  });

  it("tolerates a die that is resting slightly tilted", () => {
    for (const value of VALUES) {
      for (const [tx, tz] of [[0.3, 0], [-0.3, 0.2], [0.25, -0.35], [0, 0.4]] as const) {
        const tilt = new Quaternion().setFromEuler(new Euler(tx, 1.1, tz));
        const q = tilt.multiply(faceUp(value));
        expect(topFace(q)).toBe(value);
        expect(topFaceAlignment(q)).toBeLessThan(1);
        expect(topFaceAlignment(q)).toBeGreaterThan(0.8);
      }
    }
  });

  it("agrees with a brute-force check on random orientations", () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    for (let i = 0; i < 500; i++) {
      const q = new Quaternion(rnd(), rnd(), rnd(), rnd()).normalize();
      let best: DieValue = 1;
      let bestDot = -Infinity;
      for (const value of VALUES) {
        const dot = new Vector3(...FACE_NORMALS[value]).applyQuaternion(q).dot(UP);
        if (dot > bestDot) [best, bestDot] = [value, dot];
      }
      expect(topFace(q)).toBe(best);
      expect(topFaceAlignment(q)).toBeCloseTo(bestDot, 10);
    }
  });

  it("accepts plain quaternion-shaped objects (e.g. Rapier rotations)", () => {
    const { x, y, z, w } = faceUp(6);
    expect(topFace({ x, y, z, w })).toBe(6);
  });
});
