import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  BackSide,
  BoxGeometry,
  Color,
  type DirectionalLight,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
} from "three";
import { RAIL_THICKNESS, TRAY_DEPTH, TRAY_WIDTH } from "./tray";

/**
 * A tiny procedural "studio" rendered once into a prefiltered environment map:
 * a dim room plus a few emissive panels. Gives the dice and rail soft, believable
 * reflections with zero network requests and no image assets.
 */
function buildStudio(): Scene {
  const studio = new Scene();
  const geometries = { room: new BoxGeometry(40, 40, 40), panel: new PlaneGeometry(1, 1) };

  studio.add(new Mesh(geometries.room, new MeshBasicMaterial({ color: new Color(0.07, 0.065, 0.06), side: BackSide })));

  const panel = (
    color: string,
    intensity: number,
    position: [number, number, number],
    size: [number, number],
  ) => {
    const material = new MeshBasicMaterial({ color: new Color(color).multiplyScalar(intensity), side: DoubleSide });
    const mesh = new Mesh(geometries.panel, material);
    mesh.position.set(...position);
    mesh.scale.set(size[0], size[1], 1);
    mesh.lookAt(0, 0, 0);
    studio.add(mesh);
  };

  panel("#fff4e2", 5, [2, 14, 3], [16, 12]); // big overhead softbox (matches the key light)
  panel("#ffd9a8", 3.5, [16, 5, 4], [6, 10]); // warm side strip
  panel("#a9c8ff", 2.5, [-15, 6, -6], [8, 8]); // cool fill / rim
  panel("#ffffff", 6, [-4, 7, 15], [10, 2.5]); // thin strip behind the camera for edge glints
  return studio;
}

function StudioEnvironment({ intensity = 1 }: { intensity?: number }) {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);

  useEffect(() => {
    const pmrem = new PMREMGenerator(gl);
    const studio = buildStudio();
    const target = pmrem.fromScene(studio, 0.035);
    const previous = scene.environment;
    scene.environment = target.texture;
    return () => {
      scene.environment = previous;
      target.dispose();
      pmrem.dispose();
      studio.traverse((object) => {
        if (object instanceof Mesh) (object.material as MeshBasicMaterial).dispose();
      });
      // The two geometries are shared across the studio's meshes.
      const disposed = new Set<unknown>();
      studio.traverse((object) => {
        if (object instanceof Mesh && !disposed.has(object.geometry)) {
          disposed.add(object.geometry);
          object.geometry.dispose();
        }
      });
    };
  }, [gl, scene]);

  useEffect(() => {
    scene.environmentIntensity = intensity;
  }, [scene, intensity]);

  return null;
}

// ---------------------------------------------------------------------------------------------
// Adaptive quality (pure logic)
// ---------------------------------------------------------------------------------------------

export interface QualityTier {
  name: "high" | "medium" | "low" | "minimum";
  /** Upper bound for the canvas pixel ratio (the device's own ratio still applies below it). */
  maxDpr: number;
  /** Side of the key light's square shadow map, in texels. */
  shadowMapSize: number;
}

/** Best first. Pixel ratio is by far the biggest lever on phones (fill rate), shadows second. */
export const QUALITY_TIERS: readonly QualityTier[] = [
  { name: "high", maxDpr: 2, shadowMapSize: 2048 },
  { name: "medium", maxDpr: 1.5, shadowMapSize: 1024 },
  { name: "low", maxDpr: 1.25, shadowMapSize: 1024 },
  { name: "minimum", maxDpr: 1, shadowMapSize: 512 },
];

/** Frame times are averaged over windows this long before a decision is made. */
export const QUALITY_WINDOW_MS = 1000;
/** A window is "slow" above this average frame time (≈ under 48 fps)… */
export const SLOW_FRAME_MS = 21;
/** …and "terrible" above this one (under 25 fps), which drops a tier immediately. */
export const TERRIBLE_FRAME_MS = 40;
/** A window is "fast" below this (a steady 60 Hz display averages 16.7 ms). */
export const FAST_FRAME_MS = 17.6;
export const SLOW_WINDOWS_TO_DROP = 2;
export const FAST_WINDOWS_TO_RAISE = 4;
/** Windows ignored after mount and after each change (shader compiles, shadow map reallocation). */
export const WARMUP_WINDOWS = 1;

export interface QualityState {
  /** Index into `QUALITY_TIERS`. */
  tier: number;
  /** Best tier we are still willing to try; raised (made worse) when an upgrade didn't hold. */
  ceiling: number;
  slowStreak: number;
  fastStreak: number;
  warmup: number;
  /** True while the current tier was reached by an upgrade that hasn't proven itself yet. */
  onProbation: boolean;
}

export function initialQuality(tier = 0): QualityState {
  return { tier, ceiling: 0, slowStreak: 0, fastStreak: 0, warmup: WARMUP_WINDOWS, onProbation: false };
}

/**
 * Advances the controller by one measurement window. Slow windows step the quality down, a long
 * run of fast ones steps it back up, and an upgrade that immediately has to be undone is never
 * retried (so the picture can't flip-flop between two tiers).
 */
export function nextQuality(state: QualityState, averageFrameMs: number): QualityState {
  if (!Number.isFinite(averageFrameMs) || averageFrameMs <= 0) return state;
  if (state.warmup > 0) return { ...state, warmup: state.warmup - 1 };

  const last = QUALITY_TIERS.length - 1;
  if (averageFrameMs > SLOW_FRAME_MS) {
    const slowStreak = state.slowStreak + 1;
    const drop = averageFrameMs > TERRIBLE_FRAME_MS || slowStreak >= SLOW_WINDOWS_TO_DROP;
    if (!drop || state.tier >= last) return { ...state, slowStreak, fastStreak: 0 };
    const tier = state.tier + 1;
    return {
      tier,
      ceiling: state.onProbation ? Math.max(state.ceiling, tier) : state.ceiling,
      slowStreak: 0,
      fastStreak: 0,
      warmup: WARMUP_WINDOWS,
      onProbation: false,
    };
  }

  if (averageFrameMs < FAST_FRAME_MS) {
    const fastStreak = state.fastStreak + 1;
    if (fastStreak < FAST_WINDOWS_TO_RAISE) return { ...state, fastStreak, slowStreak: 0 };
    if (state.tier <= state.ceiling) return { ...state, fastStreak: 0, slowStreak: 0, onProbation: false };
    return { ...state, tier: state.tier - 1, slowStreak: 0, fastStreak: 0, warmup: WARMUP_WINDOWS, onProbation: true };
  }

  return { ...state, slowStreak: 0, fastStreak: 0 };
}

/** Folds per-frame deltas into fixed windows; long gaps (hidden tab, breakpoints) are discarded. */
export function createFrameWindow(windowMs = QUALITY_WINDOW_MS, maxFrameMs = 250) {
  let total = 0;
  let frames = 0;
  return {
    /** Adds a frame; returns the window's average frame time when a window completes, else null. */
    push(frameMs: number): number | null {
      if (!(frameMs > 0) || frameMs > maxFrameMs) {
        total = 0;
        frames = 0;
        return null;
      }
      total += frameMs;
      frames += 1;
      if (total < windowMs) return null;
      const average = total / frames;
      total = 0;
      frames = 0;
      return average;
    },
  };
}

/** `?quality=high|medium|low|minimum` pins a tier (no adaptation); anything else means automatic. */
export function parseQualityOverride(search: string): number | null {
  const match = /[?&]quality=([a-z]+)/.exec(search);
  if (!match) return null;
  const index = QUALITY_TIERS.findIndex((tier) => tier.name === match[1]);
  return index >= 0 ? index : null;
}

// ---------------------------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------------------------

/** Phones and tablets start one tier down: they have dense screens and modest GPUs. */
function startingTier(): number {
  try {
    return window.matchMedia("(pointer: coarse)").matches ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * Watches frame times and trades resolution / shadow detail for smoothness.
 * Calls `onShadowMapSize` when the key light's shadow map should be reallocated.
 */
function AdaptiveQuality({ onShadowMapSize }: { onShadowMapSize: (size: number) => void }) {
  const gl = useThree((state) => state.gl);
  const setDpr = useThree((state) => state.setDpr);
  const get = useThree((state) => state.get);

  const control = useRef<{ state: QualityState; pinned: boolean; frames: ReturnType<typeof createFrameWindow> } | null>(null);
  if (control.current === null) {
    const override = typeof window === "undefined" ? null : parseQualityOverride(window.location.search);
    control.current = {
      state: initialQuality(override ?? startingTier()),
      pinned: override !== null,
      frames: createFrameWindow(),
    };
  }

  const apply = (tierIndex: number) => {
    const tier = QUALITY_TIERS[tierIndex] ?? QUALITY_TIERS[0]!;
    const device = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const dpr = Math.max(1, Math.min(device, tier.maxDpr));
    // <Canvas> re-applies its own dpr prop whenever it re-renders, so this is re-checked each window.
    if (Math.abs(get().viewport.dpr - dpr) > 1e-3) setDpr(dpr);
    onShadowMapSize(tier.shadowMapSize);
    gl.domElement.dataset.quality = tier.name;
  };

  useLayoutEffect(() => {
    apply(control.current!.state.tier);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl]);

  useFrame((_, delta) => {
    const current = control.current!;
    const average = current.frames.push(delta * 1000);
    if (average === null) return;
    if (!current.pinned) current.state = nextQuality(current.state, average);
    apply(current.state.tier);
  });

  return null;
}

/** Half-extent of the area the shadow map has to cover (tray + rail + a little slack). */
const SHADOW_EXTENT = Math.max(TRAY_WIDTH, TRAY_DEPTH) / 2 + RAIL_THICKNESS + 1.2;
const FULL_SHADOW_MAP = QUALITY_TIERS[0]!.shadowMapSize;

/** Soft key light with shadows, a cool shadowless fill, and studio reflections. */
export function Lighting() {
  const key = useRef<DirectionalLight>(null);
  useLayoutEffect(() => {
    key.current?.shadow.camera.updateProjectionMatrix();
  }, []);

  const setShadowMapSize = useCallback((size: number) => {
    const shadow = key.current?.shadow;
    if (!shadow || shadow.mapSize.x === size) return;
    shadow.mapSize.set(size, size);
    // Keep the penumbra the same width in world units when the map gets coarser.
    shadow.radius = Math.max(1, (3 * size) / FULL_SHADOW_MAP);
    shadow.map?.dispose();
    shadow.map = null; // three reallocates it at the new size on the next render
    shadow.needsUpdate = true;
  }, []);

  return (
    <>
      <StudioEnvironment intensity={0.55} />
      <AdaptiveQuality onShadowMapSize={setShadowMapSize} />
      <hemisphereLight args={["#fff1dc", "#0d1f16", 0.2]} />
      <directionalLight
        ref={key}
        castShadow
        position={[5, 9.5, 4]}
        intensity={2.9}
        color="#fff3e0"
        shadow-radius={3}
        shadow-bias={-0.0004}
        shadow-normalBias={0.02}
        shadow-camera-left={-SHADOW_EXTENT}
        shadow-camera-right={SHADOW_EXTENT}
        shadow-camera-top={SHADOW_EXTENT}
        shadow-camera-bottom={-SHADOW_EXTENT}
        shadow-camera-near={2}
        shadow-camera-far={26}
      />
      <directionalLight position={[-6, 6, -3]} intensity={0.45} color="#bcd4ff" />
    </>
  );
}
