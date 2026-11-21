import { describe, expect, it } from "vitest";
import {
  createFrameWindow,
  FAST_WINDOWS_TO_RAISE,
  initialQuality,
  nextQuality,
  parseQualityOverride,
  QUALITY_TIERS,
  SLOW_WINDOWS_TO_DROP,
  type QualityState,
} from "./Lighting";

const run = (state: QualityState, frameMs: number, windows: number) => {
  for (let i = 0; i < windows; i++) state = nextQuality(state, frameMs);
  return state;
};
/** A state that is past its warm-up window. */
const warm = (tier = 0) => nextQuality(initialQuality(tier), 16.7);

describe("nextQuality", () => {
  it("ignores the warm-up window", () => {
    expect(nextQuality(initialQuality(), 500).tier).toBe(0);
  });

  it("stays put at a steady 60 fps on the best tier", () => {
    expect(run(warm(), 16.7, 60).tier).toBe(0);
  });

  it("drops a tier after sustained slow windows, not after a single hiccup", () => {
    const hiccup = nextQuality(warm(), 25);
    expect(hiccup.tier).toBe(0);
    expect(nextQuality(hiccup, 16.7).slowStreak).toBe(0);
    expect(run(warm(), 25, SLOW_WINDOWS_TO_DROP).tier).toBe(1);
  });

  it("drops immediately when frames are terrible", () => {
    expect(nextQuality(warm(), 80).tier).toBe(1);
  });

  it("bottoms out at the last tier", () => {
    const state = run(warm(), 100, 50);
    expect(state.tier).toBe(QUALITY_TIERS.length - 1);
  });

  it("climbs back after a long fast run", () => {
    let state = run(warm(), 100, 2); // drop, then warm-up
    expect(state.tier).toBe(1);
    state = run(state, 16.7, FAST_WINDOWS_TO_RAISE - 1);
    expect(state.tier).toBe(1);
    state = nextQuality(state, 16.7);
    expect(state.tier).toBe(0);
    expect(state.onProbation).toBe(true);
  });

  it("never retries an upgrade that had to be undone", () => {
    let state = run(warm(), 100, 2); // tier 1
    state = run(state, 16.7, FAST_WINDOWS_TO_RAISE); // back to 0, on probation
    state = run(state, 30, 1 + SLOW_WINDOWS_TO_DROP); // warm-up, then slow again
    expect(state.tier).toBe(1);
    expect(state.ceiling).toBe(1);
    expect(run(state, 8, 200).tier).toBe(1);
  });

  it("ignores nonsense samples", () => {
    const state = warm();
    expect(nextQuality(state, Number.NaN)).toBe(state);
    expect(nextQuality(state, 0)).toBe(state);
  });
});

describe("createFrameWindow", () => {
  it("reports the average once a window fills", () => {
    const window = createFrameWindow(100);
    for (let i = 0; i < 4; i++) expect(window.push(20)).toBeNull();
    expect(window.push(20)).toBe(20);
    expect(window.push(20)).toBeNull();
  });

  it("throws away a window interrupted by a long gap", () => {
    const window = createFrameWindow(100);
    window.push(40);
    window.push(40);
    expect(window.push(5000)).toBeNull();
    expect(window.push(10)).toBeNull();
    for (let i = 0; i < 8; i++) window.push(10);
    expect(window.push(10)).toBe(10);
  });
});

describe("parseQualityOverride", () => {
  it("reads a tier name from the query string", () => {
    expect(parseQualityOverride("?quality=high")).toBe(0);
    expect(parseQualityOverride("?a=1&quality=minimum")).toBe(QUALITY_TIERS.length - 1);
    expect(parseQualityOverride("?quality=auto")).toBeNull();
    expect(parseQualityOverride("")).toBeNull();
  });
});
