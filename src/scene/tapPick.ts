/** A die as it appears on screen right now, in CSS pixels relative to the canvas. */
export interface ScreenDie {
  index: number;
  x: number;
  y: number;
  /** Half the die's on-screen width. */
  radius: number;
}

/** How far past a die's own edge a tap still counts, as a multiple of its on-screen half-width. */
export const TAP_REACH = 2.2;
/** Never smaller than this, so dice stay tappable with a fingertip on a small screen. */
export const MIN_TAP_REACH_PX = 32;

/**
 * Which die a tap at (x, y) means: the nearest one whose generous tap zone contains it.
 * Between two neighbours the zone splits at the midpoint, so a tap goes to the closer die.
 */
export function pickDie(x: number, y: number, dice: readonly ScreenDie[]): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const die of dice) {
    const distance = Math.hypot(x - die.x, y - die.y);
    const reach = Math.max(die.radius * TAP_REACH, MIN_TAP_REACH_PX);
    if (distance <= reach && distance < bestDistance) {
      best = die.index;
      bestDistance = distance;
    }
  }
  return best;
}

/** Pointer travel (CSS px) between down and up beyond which it is a drag, not a tap. */
export function tapSlop(pointerType: string): number {
  return pointerType === "mouse" ? 8 : 14;
}
