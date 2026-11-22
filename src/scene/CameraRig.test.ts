import { describe, expect, it } from "vitest";
import {
  computeFraming,
  effectiveInsets,
  fitPose,
  frameCorners,
  growInset,
  HUD_GAP,
  HUD_INSET_BOTTOM,
  HUD_INSET_TOP,
  LANDSCAPE_PITCH_DEG,
  projectToScreen,
  type FramingInput,
  type Vec3,
} from "./CameraRig";

const FOV = 40;
const VIEWPORTS: Array<[number, number]> = [
  [1440, 900],
  [1280, 800],
  [390, 844],
  [844, 390],
  [360, 640],
  [768, 1024],
  [1024, 768],
  [800, 800],
  [2560, 1080],
];

function screenBounds(input: FramingInput) {
  const framing = computeFraming(input);
  const points = frameCorners().map((corner) => projectToScreen(corner, framing, input));
  return {
    framing,
    left: Math.min(...points.map((p) => p.x)),
    right: Math.max(...points.map((p) => p.x)),
    top: Math.min(...points.map((p) => p.y)),
    bottom: Math.max(...points.map((p) => p.y)),
  };
}

describe("effectiveInsets", () => {
  it("uses the pixel insets on tall viewports", () => {
    expect(effectiveInsets(390, 844)).toMatchObject({ top: HUD_INSET_TOP, bottom: HUD_INSET_BOTTOM });
  });

  it("caps them on short viewports so the tray keeps a fair share of the screen", () => {
    // A phone on its side with a tall (8-player) scoreboard and the dock, as measured.
    const insets = effectiveInsets(844, 390, { top: 166, bottom: 84, left: 0, right: 0 });
    expect(insets.top).toBeLessThan(166);
    expect(insets.bottom).toBe(84);
    expect(390 - insets.top - insets.bottom).toBeGreaterThan(390 * 0.45);
    // The usual landscape-phone HUD (scoreboard to ~103 px) fits uncapped.
    expect(effectiveInsets(844, 390, { top: 112, bottom: 84, left: 0, right: 0 }).top).toBe(112);
  });
});

describe("growInset", () => {
  it("adds the gap, rounds up, and ignores missing measurements", () => {
    expect(growInset(null, 94)).toBe(Math.ceil((94 + HUD_GAP) / 4) * 4);
    expect(growInset(null, null)).toBeNull();
    expect(growInset(120, null)).toBe(120);
    expect(growInset(null, 0)).toBeNull();
  });

  it("only ever grows, so the camera doesn't follow the HUD around", () => {
    const tall = growInset(null, 150);
    expect(growInset(tall, 90)).toBe(tall);
    expect(growInset(tall, 151)).toBe(tall); // within the rounding
    expect(growInset(tall, 170)).toBeGreaterThan(tall!);
  });
});

describe("computeFraming", () => {
  it.each(VIEWPORTS)("keeps the tray inside the HUD insets at %ix%i", (width, height) => {
    const input = { width, height, fovDeg: FOV };
    const { framing, left, right, top, bottom } = screenBounds(input);
    const eps = 0.01;
    expect(left).toBeGreaterThanOrEqual(framing.insets.left - eps);
    expect(right).toBeLessThanOrEqual(width - framing.insets.right + eps);
    expect(top).toBeGreaterThanOrEqual(framing.insets.top - eps);
    expect(bottom).toBeLessThanOrEqual(height - framing.insets.bottom + eps);
  });

  it.each(VIEWPORTS)("fills the free space along at least one axis at %ix%i", (width, height) => {
    const { framing, left, right, top, bottom } = screenBounds({ width, height, fovDeg: FOV });
    const freeWidth = width - framing.insets.left - framing.insets.right;
    const freeHeight = height - framing.insets.top - framing.insets.bottom;
    const fill = Math.max((right - left) / freeWidth, (bottom - top) / freeHeight);
    expect(fill).toBeGreaterThan(0.999);
  });

  it.each(VIEWPORTS)("centres the tray in the free space on the slack axis at %ix%i", (width, height) => {
    const { framing, left, right, top, bottom } = screenBounds({ width, height, fovDeg: FOV });
    // Roughly equal gaps either side (corners at different depths make this approximate in px).
    const gapLeft = left - framing.insets.left;
    const gapRight = width - framing.insets.right - right;
    expect(Math.abs(gapLeft - gapRight)).toBeLessThan(width * 0.02);
    const gapTop = top - framing.insets.top;
    const gapBottom = height - framing.insets.bottom - bottom;
    expect(Math.abs(gapTop - gapBottom)).toBeLessThan(height * 0.02);
  });

  it("uses the straight three-quarter view on wide screens", () => {
    for (const [width, height] of [[1440, 900], [1280, 800], [844, 390]] as const) {
      const framing = computeFraming({ width, height, fovDeg: FOV });
      expect(framing.rotated).toBe(false);
      expect(framing.pitchDeg).toBe(LANDSCAPE_PITCH_DEG);
      expect(framing.position[0]).toBeCloseTo(0, 6);
    }
  });

  it("rotates and steepens the view on portrait phones, making the tray bigger", () => {
    const input = { width: 390, height: 844, fovDeg: FOV };
    const framing = computeFraming(input);
    expect(framing.rotated).toBe(true);
    expect(framing.pitchDeg).toBeGreaterThan(LANDSCAPE_PITCH_DEG);
    expect(framing.distance).toBeLessThan(fitPose(input, LANDSCAPE_PITCH_DEG, 0).distance);
  });

  it("returns an orthonormal, right-handed basis looking at the table", () => {
    for (const [width, height] of VIEWPORTS) {
      const { right, up, back, position } = computeFraming({ width, height, fovDeg: FOV });
      const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      expect(dot(right, right)).toBeCloseTo(1, 9);
      expect(dot(up, up)).toBeCloseTo(1, 9);
      expect(dot(back, back)).toBeCloseTo(1, 9);
      expect(dot(right, up)).toBeCloseTo(0, 9);
      expect(dot(right, back)).toBeCloseTo(0, 9);
      expect(dot(up, back)).toBeCloseTo(0, 9);
      // right x up = back
      expect(right[1] * up[2] - right[2] * up[1]).toBeCloseTo(back[0], 9);
      expect(right[2] * up[0] - right[0] * up[2]).toBeCloseTo(back[1], 9);
      expect(right[0] * up[1] - right[1] * up[0]).toBeCloseTo(back[2], 9);
      expect(position[1]).toBeGreaterThan(3); // above the table
      expect(Number.isFinite(position[0] + position[1] + position[2])).toBe(true);
    }
  });

  it("honours custom insets", () => {
    const input = { width: 1000, height: 800, fovDeg: FOV, insets: { top: 0, bottom: 0, left: 150, right: 0 } };
    const { left } = screenBounds(input);
    expect(left).toBeGreaterThanOrEqual(150 - 0.01);
  });
});
