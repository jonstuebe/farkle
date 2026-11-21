/**
 * Pure gatekeeping for impact sounds: callers may report every physics contact, this decides
 * which ones are worth a voice. No Web Audio in here, so it is trivially testable.
 */

export type Surface = "felt" | "wood" | "die";

export interface HitGateOptions {
  /** Hits weaker than this are inaudible anyway. */
  minStrength: number;
  /** Minimum gap between two hits on the same surface, in ms. */
  surfaceIntervalMs: number;
  /** Minimum gap between any two hits, in ms. */
  globalIntervalMs: number;
  /** A hit this many times stronger than the one that just played may cut through the gap. */
  overrideRatio: number;
  /** Most voices allowed to ring at once. */
  maxVoices: number;
}

export const DEFAULT_HIT_GATE: HitGateOptions = {
  minStrength: 0.03,
  surfaceIntervalMs: 32,
  globalIntervalMs: 9,
  overrideRatio: 1.6,
  maxVoices: 8,
};

export interface HitGate {
  /**
   * Should a hit of `strength` (0..1) on `surface` at time `nowMs` make a sound that rings for
   * `durationMs`? Returning true reserves a voice until it has finished.
   */
  admit(nowMs: number, strength: number, surface: Surface, durationMs: number): boolean;
  /** Voices still ringing at `nowMs`. */
  activeVoices(nowMs: number): number;
  reset(): void;
}

export function createHitGate(options: Partial<HitGateOptions> = {}): HitGate {
  const config = { ...DEFAULT_HIT_GATE, ...options };
  const lastOnSurface = new Map<Surface, { at: number; strength: number }>();
  let lastAny = -Infinity;
  let voiceEnds: number[] = [];

  const prune = (nowMs: number) => {
    if (voiceEnds.length > 0) voiceEnds = voiceEnds.filter((end) => end > nowMs);
  };

  return {
    admit(nowMs, strength, surface, durationMs) {
      if (!Number.isFinite(nowMs) || !Number.isFinite(strength) || strength < config.minStrength) return false;
      prune(nowMs);
      if (voiceEnds.length >= config.maxVoices) return false;
      if (nowMs - lastAny < config.globalIntervalMs) return false;
      const previous = lastOnSurface.get(surface);
      if (
        previous &&
        nowMs - previous.at < config.surfaceIntervalMs &&
        strength < previous.strength * config.overrideRatio
      ) {
        return false;
      }
      lastOnSurface.set(surface, { at: nowMs, strength });
      lastAny = nowMs;
      voiceEnds.push(nowMs + Math.max(0, durationMs));
      return true;
    },
    activeVoices(nowMs) {
      prune(nowMs);
      return voiceEnds.length;
    },
    reset() {
      lastOnSurface.clear();
      lastAny = -Infinity;
      voiceEnds = [];
    },
  };
}

/** Clamps a caller-supplied strength to 0..1 (NaN and friends become 0). */
export function clampStrength(strength: number): number {
  return Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
}

/** Perceptual loudness for an impact: quiet taps stay quiet, hard hits don't blow out. */
export function hitGain(strength: number): number {
  return Math.pow(clampStrength(strength), 1.4);
}

/** A multiplier in [1 - spread, 1 + spread]; `random` is injectable for tests. */
export function vary(spread: number, random: () => number = Math.random): number {
  return 1 + (random() * 2 - 1) * spread;
}
