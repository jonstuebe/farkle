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
