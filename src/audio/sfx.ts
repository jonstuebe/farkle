/**
 * Sound effects API. STUB: every function is a no-op until the audio worker implements it.
 * Callers may invoke these freely (including every frame-ish collision); implementations
 * must be cheap, throttle themselves, and never throw.
 */

/** A die hit the felt, a rail, or another die. `strength` is 0..1 (impact speed, normalised). */
export function playDiceHit(_strength: number, _surface: "felt" | "wood" | "die"): void {}

/** A die was selected or deselected. */
export function playSelect(_selected: boolean): void {}

/** Points were banked. */
export function playBank(): void {}

/** The player farkled. */
export function playFarkle(): void {}

/** Hot dice: all six dice scored. */
export function playHotDice(): void {}

/** Game over. */
export function playWin(): void {}
