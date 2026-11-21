/**
 * Pure die-model facts shared by the renderer, the physics body and the game.
 * No DOM / WebGL access in here, so it is safe to import from tests and game logic.
 */

export type DieValue = 1 | 2 | 3 | 4 | 5 | 6;

/** Edge length of a die in world units. The collider and the mesh both derive from this. */
export const DIE_SIZE = 0.8;
/** Radius of the rounded edges/corners (shared by mesh and collider so they match exactly). */
export const DIE_RADIUS = 0.1;

/**
 * Face value on each local axis, in three.js box-face order: +X, -X, +Y, -Y, +Z, -Z.
 * Opposite faces sum to 7, and 1-2-3 run counter-clockwise around their shared
 * corner (a standard "right-handed" western die).
 */
export const FACE_VALUES = [2, 5, 3, 4, 1, 6] as const satisfies readonly DieValue[];

/** Local-space outward normal of each face value. */
export const FACE_NORMALS: Readonly<Record<DieValue, readonly [number, number, number]>> = {
  1: [0, 0, 1],
  2: [1, 0, 0],
  3: [0, 1, 0],
  4: [0, -1, 0],
  5: [-1, 0, 0],
  6: [0, 0, -1],
};

/** Anything quaternion-shaped: THREE.Quaternion, Rapier's Rotation, plain objects. */
export interface QuaternionLike {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * World up (+Y) expressed in the die's local frame, i.e. the second row of the
 * rotation matrix of `q`. Assumes a unit quaternion.
 */
function localUp(q: QuaternionLike): [number, number, number] {
  const { x, y, z, w } = q;
  return [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)];
}

/** The face value pointing most nearly up (+Y) for a die with world rotation `quaternion`. */
export function topFace(quaternion: QuaternionLike): DieValue {
  const [ux, uy, uz] = localUp(quaternion);
  const ax = Math.abs(ux);
  const ay = Math.abs(uy);
  const az = Math.abs(uz);
  if (ax >= ay && ax >= az) return ux > 0 ? FACE_VALUES[0] : FACE_VALUES[1];
  if (ay >= az) return uy > 0 ? FACE_VALUES[2] : FACE_VALUES[3];
  return uz > 0 ? FACE_VALUES[4] : FACE_VALUES[5];
}

/**
 * How squarely the top face points up: 1 = lying perfectly flat, ~0.58 = balanced on a
 * corner. Useful for spotting a "cocked" die leaning on a rail or another die
 * (anything below ~0.95 is visibly tilted).
 */
export function topFaceAlignment(quaternion: QuaternionLike): number {
  const [ux, uy, uz] = localUp(quaternion);
  return Math.max(Math.abs(ux), Math.abs(uy), Math.abs(uz));
}

/**
 * Pip centres per face value on a 3x3 grid, as [column, row] in -1..1
 * (multiply by PIP_SPACING to get die units from the face centre).
 */
export const PIP_LAYOUT: Readonly<Record<DieValue, readonly (readonly [number, number])[]>> = {
  1: [[0, 0]],
  2: [[-1, 1], [1, -1]],
  3: [[-1, 1], [0, 0], [1, -1]],
  4: [[-1, -1], [-1, 1], [1, -1], [1, 1]],
  5: [[-1, -1], [-1, 1], [0, 0], [1, -1], [1, 1]],
  6: [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]],
};

/** Distance between neighbouring pip centres, as a fraction of DIE_SIZE. */
export const PIP_SPACING = 0.245;
/** Pip radius as a fraction of DIE_SIZE (the single pip on the 1 face is drawn larger). */
export const PIP_RADIUS = 0.082;
export const PIP_RADIUS_ONE = 0.11;
