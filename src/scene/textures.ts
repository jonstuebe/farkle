/**
 * Procedural, canvas-generated textures. Everything here is built once on first use
 * and shared by every mesh, so there are no image downloads and no per-die cost.
 */
import {
  BufferAttribute,
  CanvasTexture,
  type BufferGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  DIE_RADIUS,
  DIE_SIZE,
  FACE_VALUES,
  PIP_LAYOUT,
  PIP_RADIUS,
  PIP_RADIUS_ONE,
  PIP_SPACING,
  type DieValue,
} from "./dice";

/** Small deterministic PRNG so the textures look identical on every load. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  return { canvas, ctx };
}

function finish(canvas: HTMLCanvasElement, srgb: boolean, repeat?: [number, number]): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  if (srgb) texture.colorSpace = SRGBColorSpace;
  if (repeat) {
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.repeat.set(...repeat);
  }
  texture.anisotropy = 8;
  return texture;
}

function once<T>(build: () => T): () => T {
  let value: T | undefined;
  return () => (value ??= build());
}

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

/** The six faces live in one 3x2 atlas so a die is a single material / draw call. */
const ATLAS_COLS = 3;
const ATLAS_ROWS = 2;
const CELL = 256;
/** Pip dimple depth relative to its radius. */
const PIP_DEPTH = 0.55;

const atlasCell = (value: DieValue) => ({ col: (value - 1) % ATLAS_COLS, row: Math.floor((value - 1) / ATLAS_COLS) });

/** Colour + tangent-space normal atlases: ivory faces with dark, dished pips. */
export const getDiceTextures = once((): { map: Texture; normalMap: Texture } => {
  const width = CELL * ATLAS_COLS;
  const height = CELL * ATLAS_ROWS;
  const color = makeCanvas(width, height);
  const normal = makeCanvas(width, height);

  color.ctx.fillStyle = "#f3ecdc";
  color.ctx.fillRect(0, 0, width, height);

  // Very faint mottling so the resin isn't a perfectly flat colour.
  const rnd = mulberry32(7);
  for (let i = 0; i < 900; i++) {
    const r = 6 + rnd() * 22;
    color.ctx.fillStyle = rnd() > 0.5 ? "rgba(255,252,240,0.035)" : "rgba(150,120,70,0.022)";
    color.ctx.beginPath();
    color.ctx.arc(rnd() * width, rnd() * height, r, 0, Math.PI * 2);
    color.ctx.fill();
  }

  const normals = normal.ctx.createImageData(width, height);
  const data = normals.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 128;
    data[i + 1] = 128;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  for (const value of [1, 2, 3, 4, 5, 6] as const) {
    const { col, row } = atlasCell(value);
    const radius = (value === 1 ? PIP_RADIUS_ONE : PIP_RADIUS) * CELL;
    const depth = radius * PIP_DEPTH;
    for (const [gx, gy] of PIP_LAYOUT[value]) {
      const cx = (col + 0.5 + gx * PIP_SPACING) * CELL;
      const cy = (row + 0.5 - gy * PIP_SPACING) * CELL;

      // Paint: near-black enamel, slightly lighter towards the lit lower rim.
      const paint = color.ctx.createRadialGradient(cx, cy - radius * 0.25, radius * 0.1, cx, cy, radius);
      paint.addColorStop(0, "#0b0b0d");
      paint.addColorStop(0.8, "#141418");
      paint.addColorStop(1, "#24242a");
      color.ctx.fillStyle = paint;
      color.ctx.beginPath();
      color.ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      color.ctx.fill();
      // Soft contact darkening just outside the rim (cheap ambient occlusion).
      color.ctx.strokeStyle = "rgba(60,45,25,0.18)";
      color.ctx.lineWidth = 2.5;
      color.ctx.beginPath();
      color.ctx.arc(cx, cy, radius + 1, 0, Math.PI * 2);
      color.ctx.stroke();

      // Normals of a paraboloid dimple: h(r) = -depth * (1 - (r/R)^2).
      const x0 = Math.floor(cx - radius - 2);
      const x1 = Math.ceil(cx + radius + 2);
      const y0 = Math.floor(cy - radius - 2);
      const y1 = Math.ceil(cy + radius + 2);
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const dx = px + 0.5 - cx;
          const dy = py + 0.5 - cy;
          const r = Math.hypot(dx, dy);
          // Fade the slope out over ~2px at the rim so the edge is anti-aliased.
          const edge = Math.min(1, Math.max(0, (radius + 1 - r) / 2));
          if (edge <= 0) continue;
          const k = ((2 * depth) / (radius * radius)) * edge;
          // Height gradient in texel units; canvas y points down, texture v points up.
          const nx = -k * dx;
          const ny = k * dy;
          const inv = 1 / Math.hypot(nx, ny, 1);
          const o = (py * width + px) * 4;
          data[o] = Math.round((nx * inv * 0.5 + 0.5) * 255);
          data[o + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
          data[o + 2] = Math.round((inv * 0.5 + 0.5) * 255);
        }
      }
    }
  }
  normal.ctx.putImageData(normals, 0, 0);

  return { map: finish(color.canvas, true), normalMap: finish(normal.canvas, false) };
});

/**
 * Rounded cube whose UVs are a planar projection of each face into its atlas cell,
 * so pips stay perfectly round and sit where PIP_LAYOUT says.
 */
export const getDieGeometry = once((): BufferGeometry => {
  const geometry = new RoundedBoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE, 6, DIE_RADIUS);
  const position = geometry.getAttribute("position");
  const uv = new Float32Array(position.count * 2);
  const perFace = position.count / 6;
  for (let i = 0; i < position.count; i++) {
    const face = Math.floor(i / perFace);
    const x = position.getX(i) / DIE_SIZE;
    const y = position.getY(i) / DIE_SIZE;
    const z = position.getZ(i) / DIE_SIZE;
    // (s, t) chosen so s x t = outward normal on every face (un-mirrored pips).
    let s: number;
    let t: number;
    switch (face) {
      case 0: [s, t] = [-z, y]; break;
      case 1: [s, t] = [z, y]; break;
      case 2: [s, t] = [x, -z]; break;
      case 3: [s, t] = [x, z]; break;
      case 4: [s, t] = [x, y]; break;
      default: [s, t] = [-x, y];
    }
    const { col, row } = atlasCell(FACE_VALUES[face] ?? 1);
    uv[i * 2] = (col + 0.5 + s) / ATLAS_COLS;
    uv[i * 2 + 1] = 1 - (row + 0.5 - t) / ATLAS_ROWS;
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  geometry.clearGroups();
  return geometry;
});

// ---------------------------------------------------------------------------
// Felt
// ---------------------------------------------------------------------------

/** Tileable box blur of a square scalar field. */
function blurWrapped(src: Float32Array, size: number, radius: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const norm = 1 / (radius * 2 + 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++) sum += src[y * size + ((x + d + size) % size)]!;
      tmp[y * size + x] = sum * norm;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (let d = -radius; d <= radius; d++) sum += tmp[((y + d + size) % size) * size + x]!;
      out[y * size + x] = sum * norm;
    }
  }
  return out;
}

/** Tileable felt: fine fibre noise plus soft blotches, with a matching normal map. */
export const getFeltTextures = once((repeat: [number, number] = [5, 4]): { map: Texture; normalMap: Texture } => {
  const size = 256;
  const rnd = mulberry32(1234);
  const white = new Float32Array(size * size);
  for (let i = 0; i < white.length; i++) white[i] = rnd() - 0.5;
  const fine = blurWrapped(white, size, 1);
  const blotch = blurWrapped(blurWrapped(white, size, 9), size, 9);

  const color = makeCanvas(size, size);
  const normal = makeCanvas(size, size);
  const cData = color.ctx.createImageData(size, size);
  const nData = normal.ctx.createImageData(size, size);
  const base = [17, 78, 46];
  const height = (x: number, y: number) =>
    fine[((y + size) % size) * size + ((x + size) % size)]! * 3.2 + white[((y + size) % size) * size + ((x + size) % size)]! * 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const o = i * 4;
      const shade = 1 + fine[i]! * 0.9 + white[i]! * 0.12 + blotch[i]! * 2.2;
      cData.data[o] = Math.max(0, Math.min(255, base[0]! * shade));
      cData.data[o + 1] = Math.max(0, Math.min(255, base[1]! * shade));
      cData.data[o + 2] = Math.max(0, Math.min(255, base[2]! * shade));
      cData.data[o + 3] = 255;

      const nx = -(height(x + 1, y) - height(x - 1, y)) * 0.5;
      const ny = (height(x, y + 1) - height(x, y - 1)) * 0.5;
      const inv = 1 / Math.hypot(nx, ny, 1);
      nData.data[o] = (nx * inv * 0.5 + 0.5) * 255;
      nData.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      nData.data[o + 2] = (inv * 0.5 + 0.5) * 255;
      nData.data[o + 3] = 255;
    }
  }
  color.ctx.putImageData(cData, 0, 0);
  normal.ctx.putImageData(nData, 0, 0);
  return { map: finish(color.canvas, true, repeat), normalMap: finish(normal.canvas, false, repeat) };
});

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

/** Dark walnut-ish grain running along U. Tileable in both directions. */
export const getWoodTexture = once((): Texture => {
  const w = 512;
  const h = 256;
  const { canvas, ctx } = makeCanvas(w, h);
  const rnd = mulberry32(99);
  ctx.fillStyle = "#4a2a17";
  ctx.fillRect(0, 0, w, h);

  // Broad tonal bands, then many thin wavering grain lines.
  for (let i = 0; i < 14; i++) {
    const y = rnd() * h;
    const band = 8 + rnd() * 30;
    ctx.fillStyle = rnd() > 0.5 ? "rgba(110,62,30,0.22)" : "rgba(20,8,2,0.22)";
    for (const oy of [-h, 0, h]) ctx.fillRect(0, y + oy, w, band);
  }
  for (let i = 0; i < 260; i++) {
    const y = rnd() * h;
    const amp = 0.6 + rnd() * 2.2;
    const waves = 1 + Math.floor(rnd() * 3); // whole number of waves => tiles along U
    const phase = rnd() * Math.PI * 2;
    ctx.strokeStyle = rnd() > 0.35 ? `rgba(18,7,2,${0.1 + rnd() * 0.3})` : `rgba(150,92,48,${0.06 + rnd() * 0.16})`;
    ctx.lineWidth = 0.5 + rnd() * 1.4;
    for (const oy of [-h, 0, h]) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const yy = y + oy + Math.sin((x / w) * Math.PI * 2 * waves + phase) * amp;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
  }
  return finish(canvas, true, [1, 1]);
});
