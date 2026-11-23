import { describe, expect, it } from "vitest";
import { MIN_TAP_REACH_PX, pickDie, tapSlop } from "./tapPick";

const row = [
  { index: 0, x: 100, y: 200, radius: 20 },
  { index: 1, x: 160, y: 200, radius: 20 },
];

describe("pickDie", () => {
  it("picks a die tapped directly", () => {
    expect(pickDie(100, 200, row)).toBe(0);
  });

  it("picks a die tapped just off its edge", () => {
    expect(pickDie(100, 235, row)).toBe(0);
  });

  it("splits the gap between neighbours at the midpoint", () => {
    expect(pickDie(129, 200, row)).toBe(0);
    expect(pickDie(131, 200, row)).toBe(1);
  });

  it("ignores taps far from every die", () => {
    expect(pickDie(100, 300, row)).toBeNull();
    expect(pickDie(0, 0, [])).toBeNull();
  });

  it("keeps a minimum reach for dice that are tiny on screen", () => {
    const tiny = [{ index: 3, x: 50, y: 50, radius: 4 }];
    expect(pickDie(50, 50 + MIN_TAP_REACH_PX - 1, tiny)).toBe(3);
    expect(pickDie(50, 50 + MIN_TAP_REACH_PX + 1, tiny)).toBeNull();
  });
});

describe("tapSlop", () => {
  it("forgives more movement for fingers than for a mouse", () => {
    expect(tapSlop("touch")).toBeGreaterThan(tapSlop("mouse"));
  });
});
