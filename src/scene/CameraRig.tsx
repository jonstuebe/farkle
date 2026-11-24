import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { IS_TOUCH } from "./touch";
import { RAIL_HEIGHT, RAIL_THICKNESS, TRAY_DEPTH, TRAY_WIDTH } from "./tray";

// ---------------------------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------------------------

/**
 * Screen space (CSS px) the HUD overlay needs: the tray is framed inside what is left.
 * These are fallbacks: when the HUD is on screen its real size is measured (see useHudInsets).
 */
export const HUD_INSET_TOP = 104; // scoreboard (ends at ~94-100 px on a phone) plus a small gap
export const HUD_INSET_BOTTOM = 140; // action buttons
export const HUD_INSET_LEFT = 0;
export const HUD_INSET_RIGHT = 0;
/**
 * On short viewports (a phone in landscape) fixed pixel insets would eat the whole screen, so
 * each inset is capped to this fraction of the viewport's height (top/bottom) or width (sides).
 */
export const HUD_INSET_MAX_TOP = 0.3;
export const HUD_INSET_MAX_BOTTOM = 0.25;
export const HUD_INSET_MAX_SIDE = 0.2;

/** Breathing room around the rail, in world units. */
export const FRAME_MARGIN = 0.3;
/** Camera elevation above the table plane, in degrees. Steep enough to read every top face. */
export const LANDSCAPE_PITCH_DEG = 58;
/** In the rotated (portrait) framing we look almost straight down, which uses a tall screen best. */
export const ROTATED_PITCH_DEG = 76;
/** Rotated framing: the camera swings round to the +X side so the tray's long axis runs up the screen. */
export const ROTATED_YAW_DEG = 90;
/** Only rotate when it makes the tray at least this much bigger on screen (avoids flip-flopping near square). */
export const ROTATE_MIN_GAIN = 1.12;
/**
 * Borderless (touch) framing: the felt rectangle plus this much room, in world units, so a die
 * resting against an (invisible) wall is still fully on screen.
 */
export const FELT_MARGIN = 0.1;
/** Time constant of the settle after a resize / orientation change, in seconds. */
export const SETTLE_SECONDS = 0.22;

// ---------------------------------------------------------------------------------------------
// Framing math (pure)
// ---------------------------------------------------------------------------------------------

export type Vec3 = readonly [number, number, number];

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface FramingInput {
  /** Viewport size in CSS px. */
  width: number;
  height: number;
  /** Vertical field of view, in degrees. */
  fovDeg: number;
  /** HUD insets in CSS px (before capping). Defaults to the `HUD_INSET_*` constants. */
  insets?: Insets;
  /** Frame only the felt (rail cropped off screen) instead of the whole tray. */
  feltOnly?: boolean;
}

export interface Framing {
  position: Vec3;
  /** Orthonormal camera basis in world space: screen-right, screen-up, and "back" (target → camera). */
  right: Vec3;
  up: Vec3;
  back: Vec3;
  /** Distance from the tray centre along the view axis. */
  distance: number;
  pitchDeg: number;
  yawDeg: number;
  rotated: boolean;
  /** The insets actually used, after capping. */
  insets: Insets;
}

/** Half-extents of the box the camera keeps in frame: felt + rail + margin, up to the rail's top. */
export const FRAME_HALF_WIDTH = TRAY_WIDTH / 2 + RAIL_THICKNESS + FRAME_MARGIN;
export const FRAME_HALF_DEPTH = TRAY_DEPTH / 2 + RAIL_THICKNESS + FRAME_MARGIN;
export const FRAME_TOP = RAIL_HEIGHT;

const DEG = Math.PI / 180;
const DEFAULT_INSETS: Insets = {
  top: HUD_INSET_TOP,
  bottom: HUD_INSET_BOTTOM,
  left: HUD_INSET_LEFT,
  right: HUD_INSET_RIGHT,
};

/**
 * The corners of the framed box: the whole tray up to the rail's top, or with `feltOnly` just
 * the felt rectangle (the borderless touch layout, where no rail is drawn).
 */
export function frameCorners(feltOnly = false): Vec3[] {
  if (feltOnly) {
    const halfW = TRAY_WIDTH / 2 + FELT_MARGIN;
    const halfD = TRAY_DEPTH / 2 + FELT_MARGIN;
    return [
      [-halfW, 0, -halfD],
      [-halfW, 0, halfD],
      [halfW, 0, -halfD],
      [halfW, 0, halfD],
    ];
  }
  const corners: Vec3[] = [];
  for (const x of [-FRAME_HALF_WIDTH, FRAME_HALF_WIDTH]) {
    for (const y of [0, FRAME_TOP]) {
      for (const z of [-FRAME_HALF_DEPTH, FRAME_HALF_DEPTH]) corners.push([x, y, z]);
    }
  }
  return corners;
}

/** Caps the pixel insets so they never swallow a short or narrow viewport. */
export function effectiveInsets(width: number, height: number, insets: Insets = DEFAULT_INSETS): Insets {
  const cap = (value: number, limit: number) => Math.max(0, Math.min(value, limit));
  return {
    top: cap(insets.top, height * HUD_INSET_MAX_TOP),
    bottom: cap(insets.bottom, height * HUD_INSET_MAX_BOTTOM),
    left: cap(insets.left, width * HUD_INSET_MAX_SIDE),
    right: cap(insets.right, width * HUD_INSET_MAX_SIDE),
  };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Tightest fit along one screen axis. `coords` are the corners' offsets along that axis and
 * `depths` their offsets towards the camera; `tanPos` / `tanNeg` are the tangents of the usable
 * half-angles on the positive / negative side (asymmetric when the insets differ).
 * A corner fits when  -tanNeg·(d - depth) <= coord - shift <= tanPos·(d - depth).
 * Returns the smallest distance `d` that fits, and the allowed camera-shift range for any `d`.
 */
function fitAxis(coords: number[], depths: number[], tanPos: number, tanNeg: number) {
  let a = -Infinity;
  let b = -Infinity;
  for (let i = 0; i < coords.length; i++) {
    a = Math.max(a, coords[i]! / tanPos + depths[i]!);
    b = Math.max(b, -coords[i]! / tanNeg + depths[i]!);
  }
  // d >= a - shift/tanPos  and  d >= b + shift/tanNeg; the two meet at the minimum.
  const minDistance = (a * tanPos + b * tanNeg) / (tanPos + tanNeg);
  const shiftFor = (d: number) => ((a - d) * tanPos + (d - b) * tanNeg) / 2; // middle of the slack
  return { minDistance, shiftFor };
}

/** Fits the frame box inside the inset viewport for one camera direction. */
export function fitPose(input: FramingInput, pitchDeg: number, yawDeg: number): Framing {
  const { width, height, fovDeg } = input;
  const insets = effectiveInsets(width, height, input.insets);
  const pitch = pitchDeg * DEG;
  const yaw = yawDeg * DEG;
  const back: Vec3 = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up: Vec3 = [-Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), -Math.sin(pitch) * Math.cos(yaw)];

  const corners = frameCorners(input.feltOnly);
  const xs = corners.map((corner) => dot(corner, right));
  const ys = corners.map((corner) => dot(corner, up));
  const depths = corners.map((corner) => dot(corner, back));

  const tanV = Math.tan((fovDeg * DEG) / 2);
  const tanH = tanV * (width / height);
  const horizontal = fitAxis(xs, depths, tanH * (1 - (2 * insets.right) / width), tanH * (1 - (2 * insets.left) / width));
  const vertical = fitAxis(ys, depths, tanV * (1 - (2 * insets.top) / height), tanV * (1 - (2 * insets.bottom) / height));

  const distance = Math.max(horizontal.minDistance, vertical.minDistance);
  const shiftX = horizontal.shiftFor(distance);
  const shiftY = vertical.shiftFor(distance);
  const position: Vec3 = [
    back[0] * distance + right[0] * shiftX + up[0] * shiftY,
    back[1] * distance + right[1] * shiftX + up[1] * shiftY,
    back[2] * distance + right[2] * shiftX + up[2] * shiftY,
  ];
  return { position, right, up, back, distance, pitchDeg, yawDeg, rotated: yawDeg !== 0, insets };
}

/**
 * Where the camera should sit so the tray fills the space the HUD leaves free.
 * Wide viewports get the classic three-quarter view from the near rail; tall ones get a steeper
 * view rotated a quarter turn, so the tray's long side runs up the screen.
 */
export function computeFraming(input: FramingInput): Framing {
  const straight = fitPose(input, LANDSCAPE_PITCH_DEG, 0);
  const rotated = fitPose(input, ROTATED_PITCH_DEG, ROTATED_YAW_DEG);
  // A shorter distance means a bigger tray on screen.
  return straight.distance > rotated.distance * ROTATE_MIN_GAIN ? rotated : straight;
}

/** Projects a world point to CSS px for a framing (used by tests and handy for debugging). */
export function projectToScreen(point: Vec3, framing: Framing, input: FramingInput): { x: number; y: number } {
  const rel: Vec3 = [
    point[0] - framing.position[0],
    point[1] - framing.position[1],
    point[2] - framing.position[2],
  ];
  const depth = -dot(rel, framing.back);
  const tanV = Math.tan((input.fovDeg * DEG) / 2);
  const tanH = tanV * (input.width / input.height);
  const ndcX = dot(rel, framing.right) / (depth * tanH);
  const ndcY = dot(rel, framing.up) / (depth * tanV);
  return { x: ((ndcX + 1) / 2) * input.width, y: ((1 - ndcY) / 2) * input.height };
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

/** Space kept between the HUD and the tray's rail, in CSS px. */
export const HUD_GAP = 8;
/** Elements of the HUD overlay the tray must stay clear of (the HUD's own class names). */
const HUD_TOP_SELECTOR = ".fk-top";
const HUD_BOTTOM_SELECTOR = ".fk-dock";
const HUD_POLL_MS = 400;
/** Framing changes this soon after mount (the HUD measured for the first time) jump instead of easing. */
const JUMP_WINDOW_MS = 1000;

/**
 * Folds a measured inset into the one in use: it only grows (rounded up to 4 px), so the
 * camera settles once instead of following the dock and scoreboard as they change height
 * between phases. A null measurement (that part of the HUD isn't there) changes nothing.
 */
export function growInset(current: number | null, measured: number | null): number | null {
  if (measured === null || !(measured > 0)) return current;
  const next = Math.ceil((measured + HUD_GAP) / 4) * 4;
  return current === null || next > current ? next : current;
}

/**
 * The HUD's real top and bottom insets over the canvas, measured from the page (the
 * scoreboard's height depends on the number of players and the layout). Falls back to the
 * HUD_INSET_* constants where the HUD isn't on screen, and starts afresh when the viewport
 * changes size.
 */
function useHudInsets(canvas: HTMLElement, width: number, height: number): Insets {
  const [measured, setMeasured] = useState<{ top: number | null; bottom: number | null }>({ top: null, bottom: null });

  useEffect(() => {
    let current = { top: null as number | null, bottom: null as number | null };
    setMeasured(current);
    const measure = () => {
      const area = canvas.getBoundingClientRect();
      if (area.height === 0) return;
      const box = (selector: string) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return rect && rect.width > 0 && rect.height > 0 ? rect : null;
      };
      const top = box(HUD_TOP_SELECTOR);
      const bottom = box(HUD_BOTTOM_SELECTOR);
      const next = {
        top: growInset(current.top, top ? top.bottom - area.top : null),
        bottom: growInset(current.bottom, bottom ? area.bottom - bottom.top : null),
      };
      if (next.top !== current.top || next.bottom !== current.bottom) setMeasured((current = next));
    };
    measure();
    const timer = window.setInterval(measure, HUD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [canvas, width, height]);

  return useMemo(
    () => ({
      top: measured.top ?? HUD_INSET_TOP,
      bottom: measured.bottom ?? HUD_INSET_BOTTOM,
      left: HUD_INSET_LEFT,
      right: HUD_INSET_RIGHT,
    }),
    [measured.top, measured.bottom],
  );
}

/**
 * Keeps the whole tray in view at any aspect ratio (wide desktop through portrait phone), inside
 * the HUD insets, and eases to the new framing when the viewport changes. No user controls.
 */
export function CameraRig() {
  const camera = useThree((state) => state.camera);
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);
  const invalidate = useThree((state) => state.invalidate);
  const canvas = useThree((state) => state.gl.domElement);
  const insets = useHudInsets(canvas, width, height);

  const goal = useMemo(() => ({ position: new Vector3(), quaternion: new Quaternion(), basis: new Matrix4() }), []);
  const settled = useRef(true);
  const initialised = useRef(false);
  const mountedAt = useRef(0);
  useEffect(() => {
    mountedAt.current = performance.now();
  }, []);

  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera) || width === 0 || height === 0) return;
    const framing = computeFraming({ width, height, fovDeg: camera.fov, insets, feltOnly: IS_TOUCH });
    goal.position.set(...framing.position);
    goal.basis.makeBasis(
      new Vector3(...framing.right),
      new Vector3(...framing.up),
      new Vector3(...framing.back),
    );
    goal.quaternion.setFromRotationMatrix(goal.basis);
    if (!initialised.current || performance.now() - mountedAt.current < JUMP_WINDOW_MS) {
      // First layout, or the HUD's measured size arriving just after: no animation, just be
      // in the right place (this all happens behind the loading screen).
      initialised.current = true;
      camera.position.copy(goal.position);
      camera.quaternion.copy(goal.quaternion);
      camera.updateMatrixWorld();
    } else {
      settled.current = false;
    }
    invalidate();
  }, [camera, width, height, insets, goal, invalidate]);

  useFrame((_, delta) => {
    if (settled.current) return;
    const blend = 1 - Math.exp(-Math.min(delta, 0.1) / SETTLE_SECONDS);
    camera.position.lerp(goal.position, blend);
    camera.quaternion.slerp(goal.quaternion, blend);
    if (camera.position.distanceToSquared(goal.position) < 1e-6 && camera.quaternion.angleTo(goal.quaternion) < 1e-4) {
      camera.position.copy(goal.position);
      camera.quaternion.copy(goal.quaternion);
      settled.current = true;
    } else {
      invalidate();
    }
  });

  return null;
}
