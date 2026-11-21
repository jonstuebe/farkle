/**
 * Pure layout / pose maths for the game-driven dice set: where dice wait, where kept dice
 * go, how a throw starts, and how to read a finished throw. No React, no physics engine.
 */
import { Quaternion, Vector3 } from "three";
import { DIE_SIZE, FACE_NORMALS, topFace, type DieValue, type QuaternionLike } from "./dice";
import { KEEP_LANE_DEPTH, PLAY_CENTER_Z, TRAY_DEPTH, TRAY_WIDTH } from "./tray";

export type Vec3 = [number, number, number];

/** Height of a die's centre when it lies flat on the felt. */
export const REST_Y = DIE_SIZE / 2;

const SLOT_SPACING = 1.05;

/** Centre of the n-th place (0..5, left to right) in the kept-dice lane. */
export function heldSlotPosition(slot: number): Vec3 {
  return [(slot - 2.5) * SLOT_SPACING, REST_Y, TRAY_DEPTH / 2 - KEEP_LANE_DEPTH / 2];
}

/** Where die `index` waits, in a neat row mid-table, before the first throw of a turn. */
export function readyPosition(index: number): Vec3 {
  return [(index - 2.5) * SLOT_SPACING, REST_Y, PLAY_CENTER_Z];
}

/**
 * Lane slot per die (null = not held). Dice keep the slot they were given, so the row
 * doesn't reshuffle as more dice are kept; newly held dice fill the lowest free slots in
 * index order.
 */
export function assignHeldSlots(
  previous: readonly (number | null)[],
  held: readonly boolean[],
): (number | null)[] {
  const slots = held.map((isHeld, i) => (isHeld ? (previous[i] ?? null) : null));
  const taken = new Set(slots.filter((slot): slot is number => slot !== null));
  let next = 0;
  return slots.map((slot, i) => {
    if (!held[i] || slot !== null) return slot;
    while (taken.has(next)) next++;
    taken.add(next);
    return next;
  });
}

/**
 * The `rolled` payload: one value per thrown die, in ascending die-index order.
 * Returns null while any thrown die still lacks a reading.
 */
export function rolledValues(
  thrown: readonly number[],
  readings: ReadonlyMap<number, DieValue> | readonly (DieValue | null | undefined)[],
): DieValue[] | null {
  const get = (i: number) => (readings instanceof Map ? readings.get(i) : (readings as readonly (DieValue | null | undefined)[])[i]);
  const values: DieValue[] = [];
  for (const index of [...new Set(thrown)].sort((a, b) => a - b)) {
    const value = get(index);
    if (value == null) return null;
    values.push(value);
  }
  return values;
}

/** Below this the top face is visibly tilted (about 10 degrees off flat). */
export const COCKED_ALIGNMENT = 0.985;

/**
 * A die that has stopped but isn't lying flat on the felt: leaning on a rail or another
 * die (`alignment` from topFaceAlignment), or sitting on top of another die (`y` too high).
 */
export function isCocked(alignment: number, y: number): boolean {
  return alignment < COCKED_ALIGNMENT || y > REST_Y + 0.2;
}

const UP = new Vector3(0, 1, 0);

/** A square, level orientation showing `value` on top (used to seat dice from saved state). */
export function faceUpQuaternion(value: DieValue): Quaternion {
  return new Quaternion().setFromUnitVectors(new Vector3(...FACE_NORMALS[value]), UP);
}

/** The nearest orientation with the current top face exactly level. Keeps the die's heading. */
export function levelQuaternion(q: QuaternionLike): Quaternion {
  const current = new Quaternion(q.x, q.y, q.z, q.w).normalize();
  const normal = new Vector3(...FACE_NORMALS[topFace(current)]).applyQuaternion(current);
  return new Quaternion().setFromUnitVectors(normal, UP).multiply(current).normalize();
}

/** Like levelQuaternion, and also turned to the nearest quarter turn so the die sits square. */
export function squareUpQuaternion(q: QuaternionLike): Quaternion {
  const level = levelQuaternion(q);
  const [nx] = FACE_NORMALS[topFace(level)];
  // Any local axis lying in the table plane tells us the heading.
  const side = (nx !== 0 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0)).applyQuaternion(level);
  const heading = Math.atan2(side.z, side.x);
  const snapped = Math.round(heading / (Math.PI / 2)) * (Math.PI / 2);
  // Rotating about +Y by t moves a heading h to h - t.
  return new Quaternion().setFromAxisAngle(UP, heading - snapped).multiply(level).normalize();
}

export interface Throw {
  position: Vec3;
  /** Euler XYZ. */
  rotation: Vec3;
  linearVelocity: Vec3;
  angularVelocity: Vec3;
}

/**
 * Launch for the n-th of `count` dice thrown together: a loose handful (up to 3 across,
 * 2 deep) near the left rail, travelling right and slightly down with plenty of tumble.
 */
export function makeThrow(n: number, count: number, random: () => number = Math.random): Throw {
  const rand = (min: number, max: number) => min + random() * (max - min);
  const randSigned = (min: number, max: number) => rand(min, max) * (random() < 0.5 ? -1 : 1);
  const col = n % 3;
  const row = Math.floor(n / 3) % 2;
  const across = Math.min(Math.max(count, 1), 3);
  return {
    position: [
      -TRAY_WIDTH / 2 + 1.1 + row * 1.05 + rand(-0.08, 0.08),
      2.1 + ((n * 7) % 3) * 0.45 + rand(0, 0.3),
      PLAY_CENTER_Z + (col - (across - 1) / 2) * 1.1 + rand(-0.1, 0.1),
    ],
    rotation: [rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2)],
    linearVelocity: [rand(6.5, 10), rand(-2, 0.5), rand(-2.3, 2.3)],
    angularVelocity: [randSigned(4, 14), randSigned(4, 14), randSigned(6, 16)],
  };
}

/** Normalise an impact (velocity change, in units/s) to the 0..1 strength the audio wants. */
export function impactStrength(deltaV: number): number {
  const MIN = 1; // resting contact under gravity is ~0.6
  const MAX = 9;
  if (!(deltaV > MIN)) return 0;
  return Math.min(1, (deltaV - MIN) / (MAX - MIN));
}

export type Phase = "awaitingRoll" | "rolling" | "choosing" | "farkled" | "other";

/** Collapse the machine's state value to the bit the scene cares about. */
export function phaseOf(stateValue: unknown): Phase {
  if (typeof stateValue === "object" && stateValue !== null && "playing" in stateValue) {
    const sub = (stateValue as { playing: unknown }).playing;
    if (sub === "awaitingRoll" || sub === "rolling" || sub === "choosing" || sub === "farkled") return sub;
  }
  return "other";
}
