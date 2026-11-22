/** Shared tray / physics-world dimensions, in world units. */

/** Inner (felt) playing area: width along X, depth along Z. */
export const TRAY_WIDTH = 10;
export const TRAY_DEPTH = 8;
/** Visible wooden rail around the felt. */
export const RAIL_THICKNESS = 0.55;
export const RAIL_HEIGHT = 0.75;
/** Invisible containment walls rise this high above the felt so a wild bounce can't escape. */
export const WALL_HEIGHT = 8;

/** Stronger than 9.81 because a die is 0.8 units wide: this reads as a small, weighty object. */
export const GRAVITY: [number, number, number] = [0, -36, 0];

/**
 * Kept-dice lane: a strip along the near rail, fenced off by a low divider, where dice set
 * aside this turn are lined up. Thrown dice can't reach it, so kept dice never get knocked.
 */
export const KEEP_LANE_DEPTH = 1.2;
export const DIVIDER_THICKNESS = 0.14;
export const DIVIDER_HEIGHT = 0.42;
/** Centre line of the divider. */
export const DIVIDER_Z = TRAY_DEPTH / 2 - KEEP_LANE_DEPTH - DIVIDER_THICKNESS / 2;
/** The felt the dice are actually thrown onto: from the far rail to the divider. */
export const PLAY_MIN_Z = -TRAY_DEPTH / 2;
export const PLAY_MAX_Z = DIVIDER_Z - DIVIDER_THICKNESS / 2;
export const PLAY_CENTER_Z = (PLAY_MIN_Z + PLAY_MAX_Z) / 2;

export interface TrayCollider {
  halfExtents: [number, number, number];
  position: [number, number, number];
  friction: number;
  restitution: number;
  /** What a die sounds like when it hits this. */
  surface: "felt" | "wood";
}

const FLOOR_THICKNESS = 0.5;
const HALF_W = TRAY_WIDTH / 2;
const HALF_D = TRAY_DEPTH / 2;
/** Rails are harder and slicker than felt, so dice kick back off them. */
const RAIL = { friction: 0.3, restitution: 0.45, surface: "wood" } as const;

/**
 * Every collider of the tray. The single source of truth for both the live scene (Table)
 * and the headless throw simulation (throwSim), so a simulated throw matches what is drawn.
 * Rails and the lane divider continue invisibly up to WALL_HEIGHT, with a lid on top.
 */
export const TRAY_COLLIDERS: readonly TrayCollider[] = [
  {
    halfExtents: [HALF_W + RAIL_THICKNESS, FLOOR_THICKNESS / 2, HALF_D + RAIL_THICKNESS],
    position: [0, -FLOOR_THICKNESS / 2, 0],
    friction: 0.85,
    restitution: 0.28,
    surface: "felt",
  },
  { halfExtents: [RAIL_THICKNESS / 2, WALL_HEIGHT / 2, HALF_D + RAIL_THICKNESS], position: [HALF_W + RAIL_THICKNESS / 2, WALL_HEIGHT / 2, 0], ...RAIL },
  { halfExtents: [RAIL_THICKNESS / 2, WALL_HEIGHT / 2, HALF_D + RAIL_THICKNESS], position: [-(HALF_W + RAIL_THICKNESS / 2), WALL_HEIGHT / 2, 0], ...RAIL },
  { halfExtents: [HALF_W + RAIL_THICKNESS, WALL_HEIGHT / 2, RAIL_THICKNESS / 2], position: [0, WALL_HEIGHT / 2, HALF_D + RAIL_THICKNESS / 2], ...RAIL },
  { halfExtents: [HALF_W + RAIL_THICKNESS, WALL_HEIGHT / 2, RAIL_THICKNESS / 2], position: [0, WALL_HEIGHT / 2, -(HALF_D + RAIL_THICKNESS / 2)], ...RAIL },
  { halfExtents: [HALF_W, WALL_HEIGHT / 2, DIVIDER_THICKNESS / 2], position: [0, WALL_HEIGHT / 2, DIVIDER_Z], ...RAIL },
  { halfExtents: [HALF_W + RAIL_THICKNESS, 0.25, HALF_D + RAIL_THICKNESS], position: [0, WALL_HEIGHT + 0.25, 0], friction: 0.5, restitution: 0, surface: "wood" },
];
