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
