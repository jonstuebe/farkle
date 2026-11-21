import { describe, expect, it } from "vitest";
import { clampStrength, createHitGate, hitGain, vary } from "./throttle";

describe("createHitGate", () => {
  it("drops hits too weak to hear", () => {
    const gate = createHitGate();
    expect(gate.admit(0, 0.01, "felt", 100)).toBe(false);
    expect(gate.admit(0, Number.NaN, "felt", 100)).toBe(false);
    expect(gate.activeVoices(0)).toBe(0);
  });

  it("throttles a burst on one surface", () => {
    const gate = createHitGate({ surfaceIntervalMs: 30, globalIntervalMs: 0 });
    let played = 0;
    for (let t = 0; t < 300; t += 2) if (gate.admit(t, 0.5, "felt", 20)) played++;
    expect(played).toBe(10);
  });

  it("lets a clearly harder hit cut through the gap", () => {
    const gate = createHitGate({ surfaceIntervalMs: 30, globalIntervalMs: 0, overrideRatio: 1.5 });
    expect(gate.admit(0, 0.2, "wood", 50)).toBe(true);
    expect(gate.admit(10, 0.25, "wood", 50)).toBe(false);
    expect(gate.admit(12, 0.9, "wood", 50)).toBe(true);
  });

  it("tracks surfaces independently but spaces everything by the global gap", () => {
    const gate = createHitGate({ surfaceIntervalMs: 30, globalIntervalMs: 5 });
    expect(gate.admit(0, 0.5, "felt", 50)).toBe(true);
    expect(gate.admit(2, 0.5, "die", 50)).toBe(false);
    expect(gate.admit(6, 0.5, "die", 50)).toBe(true);
    expect(gate.admit(12, 0.5, "wood", 50)).toBe(true);
  });

  it("caps simultaneous voices and frees them when they finish", () => {
    const gate = createHitGate({ surfaceIntervalMs: 0, globalIntervalMs: 0, maxVoices: 3 });
    expect(gate.admit(0, 0.5, "felt", 100)).toBe(true);
    expect(gate.admit(1, 0.5, "felt", 100)).toBe(true);
    expect(gate.admit(2, 0.5, "felt", 100)).toBe(true);
    expect(gate.admit(3, 1, "die", 100)).toBe(false);
    expect(gate.activeVoices(50)).toBe(3);
    expect(gate.activeVoices(101.5)).toBe(1);
    expect(gate.admit(102, 0.5, "felt", 100)).toBe(true);
  });

  it("forgets everything on reset", () => {
    const gate = createHitGate({ maxVoices: 1 });
    expect(gate.admit(0, 0.5, "felt", 1000)).toBe(true);
    expect(gate.admit(100, 0.5, "felt", 1000)).toBe(false);
    gate.reset();
    expect(gate.admit(100, 0.5, "felt", 1000)).toBe(true);
  });
});

describe("helpers", () => {
  it("clamps strength", () => {
    expect(clampStrength(-1)).toBe(0);
    expect(clampStrength(3)).toBe(1);
    expect(clampStrength(Number.NaN)).toBe(0);
    expect(clampStrength(0.4)).toBe(0.4);
  });

  it("maps strength to a monotonic gain in 0..1", () => {
    expect(hitGain(0)).toBe(0);
    expect(hitGain(1)).toBe(1);
    expect(hitGain(0.3)).toBeLessThan(hitGain(0.6));
    expect(hitGain(0.5)).toBeLessThan(0.5);
  });

  it("varies within the spread", () => {
    expect(vary(0.2, () => 0)).toBeCloseTo(0.8);
    expect(vary(0.2, () => 1)).toBeCloseTo(1.2);
    expect(vary(0.2, () => 0.5)).toBeCloseTo(1);
  });
});
