/**
 * Pure layout / pose maths for the game-driven dice set: where dice wait, where kept dice
 * go, how a throw starts, and how to make a landed die show a chosen face. No React, no physics engine.
 */
import { Quaternion, Vector3 } from "three";
import { DIE_SIZE, FACE_NORMALS, topFace, type DieValue, type QuaternionLike } from "./dice";
import { KEEP_LANE_DEPTH, PLAY_CENTER_Z, TRAY_DEPTH, TRAY_WIDTH } from "./tray";

export type Vec3 = [number, number, number];

/** Height of a die's centre when it lies flat on the felt. */
export const REST_Y = DIE_SIZE / 2;

const SLOT_SPACING = 1.05;

/** Centre-to-centre distance of neighbouring dice kept together: nearly touching, so they read as one set. */
export const KEPT_PITCH = 0.9;
/** Centre-to-centre distance across two keeps: a gap most of a die wide. */
export const KEPT_GROUP_PITCH = 1.6;
const LANE_Z = TRAY_DEPTH / 2 - KEEP_LANE_DEPTH / 2;

/** Where die `index` waits, in a neat row mid-table, before the first throw of a turn. */
export function readyPosition(index: number): Vec3 {
  return [(index - 2.5) * SLOT_SPACING, REST_Y, PLAY_CENTER_Z];
}

export interface KeptLane {
  /** Resting place per die; null = not held. */
  positions: (Vec3 | null)[];
  /** X of the middle of each gap between two keeps, left to right. */
  dividers: number[];
}

/**
 * Lays the kept-dice lane out in groups, one per keep, oldest on the left: dice kept from
 * the same roll sit shoulder to shoulder, and a wide gap separates one keep from the next,
 * because a combination only counts within one roll (three 5s kept over three rolls are
 * three lone 5s, not a set). The whole row is centred, so earlier groups slide along when a
 * new one joins. `keeps[i]` is die i's keep (`Die.keep`), or null when it isn't held.
 */
export function layoutKeptLane(keeps: readonly (number | null)[]): KeptLane {
  const held = keeps
    .flatMap((keep, index) => (keep === null ? [] : [{ keep, index }]))
    .sort((a, b) => a.keep - b.keep || a.index - b.index);
  const xs: number[] = [];
  const dividers: number[] = [];
  held.forEach((die, n) => {
    if (n === 0) return void xs.push(0);
    const previous = xs[n - 1]!;
    const sameKeep = held[n - 1]!.keep === die.keep;
    xs.push(previous + (sameKeep ? KEPT_PITCH : KEPT_GROUP_PITCH));
    if (!sameKeep) dividers.push(previous + KEPT_GROUP_PITCH / 2);
  });
  const shift = -(xs[xs.length - 1] ?? 0) / 2;
  const positions: (Vec3 | null)[] = keeps.map(() => null);
  held.forEach((die, n) => {
    positions[die.index] = [xs[n]! + shift, REST_Y, LANE_Z];
  });
  return { positions, dividers: dividers.map((x) => x + shift) };
}

/** The keep each die belongs to, for layoutKeptLane (saves from before keeps were recorded: one group). */
export function keepGroups(dice: readonly { held: boolean; keep?: number | null }[]): (number | null)[] {
  return dice.map((die) => (die.held ? (die.keep ?? 0) : null));
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

/**
 * The cube symmetry that makes a die which physically landed with `landed` up show `target`
 * instead: apply it on the right of the body's rotation (`body * remap`). Because a die is
 * a cube, the re-oriented die occupies exactly the same space throughout its flight, so
 * the throw looks identical and only the pips change places.
 */
export function faceRemapQuaternion(landed: DieValue, target: DieValue): Quaternion {
  if (landed === target) return new Quaternion();
  const from = new Vector3(...FACE_NORMALS[target]);
  const to = new Vector3(...FACE_NORMALS[landed]);
  // Opposite faces: half a turn about any axis lying in the face (pick a coordinate axis,
  // so the result is still a symmetry of the cube).
  if (landed + target === 7) {
    return new Quaternion().setFromAxisAngle(from.x !== 0 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0), Math.PI);
  }
  // Adjacent faces: a quarter turn about the axis perpendicular to both.
  return new Quaternion().setFromAxisAngle(new Vector3().crossVectors(from, to), Math.PI / 2);
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
