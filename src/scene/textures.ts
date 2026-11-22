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
// Shared helpers for tileable surfaces
// ---------------------------------------------------------------------------

/**
 * Tangent-space normal map from a greyscale height canvas (red channel), wrapping at the
 * edges so it tiles. `strength` is the slope of a full black-to-white step between texels.
 */
function normalsFromHeight(source: HTMLCanvasElement, strength: number): HTMLCanvasElement {
  const { width, height } = source;
  const src = source.getContext("2d")!.getImageData(0, 0, width, height).data;
  const { canvas, ctx } = makeCanvas(width, height);
  const out = ctx.createImageData(width, height);
  const at = (x: number, y: number) => src[(((y + height) % height) * width + ((x + width) % width)) * 4]! / 255;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sobel-ish: average the slope over three rows / columns so single texels don't sparkle.
      const dx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
      const dy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
      const nx = -dx * 0.25 * strength;
      const ny = dy * 0.25 * strength; // canvas y points down, texture v points up
      const inv = 1 / Math.hypot(nx, ny, 1);
      const o = (y * width + x) * 4;
      out.data[o] = (nx * inv * 0.5 + 0.5) * 255;
      out.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out.data[o + 2] = (inv * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return canvas;
}

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

/**
 * Tileable wool baize: thousands of short, curled fibres lying in every direction over a
 * deep green base, with faint cloudiness where the pile is thicker. The same fibres are
 * drawn into a height field, so the normal map lines up with the colour exactly.
 */
export const getFeltTextures = once((repeat: [number, number] = [5, 4]): { map: Texture; normalMap: Texture } => {
  const size = 512;
  const rnd = mulberry32(1234);
  const color = makeCanvas(size, size);
  const relief = makeCanvas(size, size);
  color.ctx.fillStyle = "#11573a";
  color.ctx.fillRect(0, 0, size, size);
  relief.ctx.fillStyle = "#7f7f7f";
  relief.ctx.fillRect(0, 0, size, size);
  color.ctx.lineCap = relief.ctx.lineCap = "round";

  const MARGIN = 28;
  for (let i = 0; i < 15000; i++) {
    const x = rnd() * size;
    const y = rnd() * size;
    const angle = rnd() * Math.PI * 2;
    const length = 7 + rnd() * 17;
    const curl = (rnd() - 0.5) * length * 0.9;
    const ex = x + Math.cos(angle) * length;
    const ey = y + Math.sin(angle) * length;
    const cx = (x + ex) / 2 - Math.sin(angle) * curl;
    const cy = (y + ey) / 2 + Math.cos(angle) * curl;
    const raised = rnd() > 0.45;
    const alpha = 0.05 + rnd() * 0.11;
    const width = 0.8 + rnd() * 1.1;
    color.ctx.strokeStyle = raised ? `rgba(96,178,128,${alpha})` : `rgba(2,26,15,${alpha * 1.5})`;
    relief.ctx.strokeStyle = raised ? `rgba(255,255,255,${alpha * 2.2})` : `rgba(0,0,0,${alpha * 2.2})`;
    color.ctx.lineWidth = relief.ctx.lineWidth = width;
    // Fibres that cross an edge are drawn again on the far side, so the tile wraps.
    const xs = x < MARGIN ? [0, size] : x > size - MARGIN ? [0, -size] : [0];
    const ys = y < MARGIN ? [0, size] : y > size - MARGIN ? [0, -size] : [0];
    for (const ox of xs) {
      for (const oy of ys) {
        for (const ctx of [color.ctx, relief.ctx]) {
          ctx.beginPath();
          ctx.moveTo(x + ox, y + oy);
          ctx.quadraticCurveTo(cx + ox, cy + oy, ex + ox, ey + oy);
          ctx.stroke();
        }
      }
    }
  }

  // Soft cloudiness: low-frequency noise multiplied into the colour.
  const white = new Float32Array(size * size);
  for (let i = 0; i < white.length; i++) white[i] = rnd() - 0.5;
  const cloud = blurWrapped(blurWrapped(white, size, 12), size, 12);
  const pixels = color.ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < cloud.length; i++) {
    const shade = 1 + cloud[i]! * 3.2 + white[i]! * 0.05;
    const o = i * 4;
    pixels.data[o] = Math.min(255, pixels.data[o]! * shade);
    pixels.data[o + 1] = Math.min(255, pixels.data[o + 1]! * shade);
    pixels.data[o + 2] = Math.min(255, pixels.data[o + 2]! * shade);
  }
  color.ctx.putImageData(pixels, 0, 0);

  return {
    map: finish(color.canvas, true, repeat),
    normalMap: finish(normalsFromHeight(relief.canvas, 3), false, repeat),
  };
});

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

/**
 * Dark walnut with the grain running along U, tileable in both directions: broad tonal
 * bands, wavering grain lines, and short open pores. Grain and pores are also cut into a
 * height field for the normal map, so the lacquer sits over wood that has real texture.
 */
export const getWoodTextures = once((): { map: Texture; normalMap: Texture } => {
  const w = 1024;
  const h = 512;
  const color = makeCanvas(w, h);
  const relief = makeCanvas(w, h);
  const rnd = mulberry32(99);
  color.ctx.fillStyle = "#4d2b17";
  color.ctx.fillRect(0, 0, w, h);
  relief.ctx.fillStyle = "#808080";
  relief.ctx.fillRect(0, 0, w, h);

  // Broad tonal bands (heartwood / sapwood), soft-edged.
  for (let i = 0; i < 22; i++) {
    const y = rnd() * h;
    const band = 14 + rnd() * 64;
    const warm = rnd() > 0.5;
    for (const oy of [-h, 0, h]) {
      const gradient = color.ctx.createLinearGradient(0, y + oy, 0, y + oy + band);
      const tone = warm ? "128,70,32" : "18,7,2";
      gradient.addColorStop(0, `rgba(${tone},0)`);
      gradient.addColorStop(0.5, `rgba(${tone},${0.16 + rnd() * 0.16})`);
      gradient.addColorStop(1, `rgba(${tone},0)`);
      color.ctx.fillStyle = gradient;
      color.ctx.fillRect(0, y + oy, w, band);
    }
  }

  // Wavering grain lines. A whole number of waves per tile keeps them seamless along U.
  for (let i = 0; i < 520; i++) {
    const y = rnd() * h;
    const amp = 1 + rnd() * 5;
    const waves = 1 + Math.floor(rnd() * 3);
    const phase = rnd() * Math.PI * 2;
    const dark = rnd() > 0.35;
    const alpha = dark ? 0.1 + rnd() * 0.3 : 0.06 + rnd() * 0.16;
    color.ctx.strokeStyle = dark ? `rgba(18,7,2,${alpha})` : `rgba(158,98,50,${alpha})`;
    relief.ctx.strokeStyle = dark ? `rgba(0,0,0,${alpha * 0.9})` : `rgba(255,255,255,${alpha * 0.6})`;
    color.ctx.lineWidth = relief.ctx.lineWidth = 0.7 + rnd() * 2.2;
    for (const oy of [-h, 0, h]) {
      for (const ctx of [color.ctx, relief.ctx]) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += 8) {
          const yy = y + oy + Math.sin((x / w) * Math.PI * 2 * waves + phase) * amp;
          if (x === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
    }
  }

  // Open pores: short dark dashes along the grain.
  color.ctx.lineCap = relief.ctx.lineCap = "round";
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * w;
    const y = rnd() * h;
    const length = 6 + rnd() * 26;
    const alpha = 0.18 + rnd() * 0.3;
    color.ctx.strokeStyle = `rgba(14,5,1,${alpha})`;
    relief.ctx.strokeStyle = `rgba(0,0,0,${alpha})`;
    color.ctx.lineWidth = relief.ctx.lineWidth = 0.6 + rnd() * 0.7;
    for (const ox of x + length > w ? [0, -w] : [0]) {
      for (const ctx of [color.ctx, relief.ctx]) {
        ctx.beginPath();
        ctx.moveTo(x + ox, y);
        ctx.lineTo(x + ox + length, y + (rnd() - 0.5) * 1.5);
        ctx.stroke();
      }
    }
  }

  return {
    map: finish(color.canvas, true, [1, 1]),
    normalMap: finish(normalsFromHeight(relief.canvas, 2.2), false, [1, 1]),
  };
});
