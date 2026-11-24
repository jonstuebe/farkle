/**
 * Materials of the table surfaces. They are three's physically based materials with a few
 * lines of extra shader code for the things a flat texture can't do: light that pools in
 * the middle of the tray, soft contact shadow where the felt meets the rails, the divider
 * and each die, and slow tonal drift across the cloth so the tiled texture never repeats.
 */
import {
  type Material,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  type Quaternion,
  Vector2,
  Vector3,
  Vector4,
} from "three";
import { DIE_RADIUS, DIE_SIZE } from "./dice";
import { getFeltTextures, getWoodTextures } from "./textures";
import { DIVIDER_THICKNESS, DIVIDER_Z, RAIL_THICKNESS, TRAY_DEPTH, TRAY_WIDTH } from "./tray";

const DICE_COUNT = 6;
/** Lift that puts a die's contact shadow out of sight (used before it has reported). */
const FAR_AWAY = 99;

/**
 * Where each die is, for the felt's contact shadows. One set of uniforms shared by every
 * felt material: dice write here each frame (see `setDiceOccluder`), the shader reads.
 */
const diceUniforms = {
  /** x, z of the die's centre; height of its underside above the felt; unused. */
  uDice: { value: Array.from({ length: DICE_COUNT }, () => new Vector4(0, 0, FAR_AWAY, 0)) },
  /** Unit direction, in the XZ plane, of one edge of the die's footprint. */
  uDiceAxis: { value: Array.from({ length: DICE_COUNT }, () => new Vector2(1, 0)) },
};

const _axes = [new Vector3(), new Vector3(), new Vector3()] as const;

/** Reports a die's pose so the felt can darken underneath it. `lift` is extra visual height. */
export function setDiceOccluder(index: number, position: Vector3, rotation: Quaternion, lift = 0) {
  const pose = diceUniforms.uDice.value[index];
  const axis = diceUniforms.uDiceAxis.value[index];
  if (!pose || !axis) return;
  pose.set(position.x, position.z, Math.max(0, position.y + lift - DIE_SIZE / 2), 0);
  // The footprint follows whichever local axis is closest to level (exact for a resting die).
  _axes[0].set(1, 0, 0).applyQuaternion(rotation);
  _axes[1].set(0, 1, 0).applyQuaternion(rotation);
  _axes[2].set(0, 0, 1).applyQuaternion(rotation);
  let level = _axes[0];
  for (const candidate of _axes) if (Math.abs(candidate.y) < Math.abs(level.y)) level = candidate;
  const length = Math.hypot(level.x, level.z);
  if (length > 1e-4) axis.set(level.x / length, level.z / length);
}

/** Takes a die's contact shadow away (when the die unmounts). */
export function clearDiceOccluder(index: number) {
  diceUniforms.uDice.value[index]?.set(0, 0, FAR_AWAY, 0);
}

const glsl = (value: number) => value.toFixed(4);

const WORLD_VARYING = /* glsl */ `
varying vec3 vSurfaceWorld;
`;

const NOISE = /* glsl */ `
float surfaceHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float surfaceNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(surfaceHash(i), surfaceHash(i + vec2(1.0, 0.0)), f.x),
    mix(surfaceHash(i + vec2(0.0, 1.0)), surfaceHash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
`;

type Shader = Parameters<Material["onBeforeCompile"]>[0];

/** Splices the extra code into three's stock shader at well-known include points. */
function extend(
  shader: Shader,
  parts: { declarations: string; albedo?: string; shading: string },
) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", `#include <common>\n${WORLD_VARYING}`)
    .replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\nvSurfaceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", `#include <common>\n${WORLD_VARYING}${NOISE}${parts.declarations}`)
    .replace("#include <map_fragment>", `#include <map_fragment>\n${parts.albedo ?? ""}`)
    // After lighting, before tone mapping: scales diffuse, sheen and reflections alike.
    .replace("#include <opaque_fragment>", `${parts.shading}\n#include <opaque_fragment>`);
}

/**
 * Wool baize lining the tray. `extent` is the size of the felt plane in world units when it is
 * bigger than the tray (the borderless touch layout): the texture is tiled to match, and there is
 * no contact shadow along the tray's edge, since no rail is drawn there.
 */
export function createFeltMaterial(extent?: number): MeshPhysicalMaterial {
  let { map, normalMap } = getFeltTextures();
  if (extent) {
    // Same tile size as on the tray: one tile per 2 world units.
    map = map.clone();
    normalMap = normalMap.clone();
    for (const texture of [map, normalMap]) {
      texture.repeat.set(extent / 2, extent / 2);
      texture.needsUpdate = true;
    }
  }
  const railShadow = extent ? "1.0" : "(1.0 - 0.5 * exp(-max(toRail, 0.0) / 0.3))";
  const material = new MeshPhysicalMaterial({
    map,
    normalMap,
    normalScale: new Vector2(0.9, 0.9),
    roughness: 1,
    metalness: 0,
    // Sheen is the soft bloom of light catching the pile at shallow angles.
    sheen: 0.8,
    sheenRoughness: 0.6,
    sheenColor: "#2f8a5c",
    envMapIntensity: 0.35,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, diceUniforms);
    extend(shader, {
      declarations: /* glsl */ `
uniform vec4 uDice[${DICE_COUNT}];
uniform vec2 uDiceAxis[${DICE_COUNT}];
`,
      albedo: /* glsl */ `
{
  // Slow drift in tone, plus faint streaks where the nap was brushed along the tray.
  float drift = surfaceNoise(vSurfaceWorld.xz * 0.8) * 0.6 + surfaceNoise(vSurfaceWorld.xz * 2.6 + 7.3) * 0.4;
  float nap = surfaceNoise(vec2(vSurfaceWorld.x * 0.3, vSurfaceWorld.z * 4.5));
  diffuseColor.rgb *= (0.9 + 0.2 * drift) * (0.955 + 0.09 * nap);
}
`,
      shading: /* glsl */ `
{
  vec2 p = vSurfaceWorld.xz;

  // Light pools in the middle of the tray and falls away towards the rails.
  float reach = length((p - vec2(0.4, -0.5)) / vec2(7.6, 6.4));
  float pool = mix(1.12, 0.66, smoothstep(0.05, 1.0, reach));

  // Contact shadow in the corner where the cloth meets the rails and the lane divider.
  float toRail = min(${glsl(TRAY_WIDTH / 2)} - abs(p.x), ${glsl(TRAY_DEPTH / 2)} - abs(p.y));
  float toDivider = abs(p.y - ${glsl(DIVIDER_Z)}) - ${glsl(DIVIDER_THICKNESS / 2)};
  float occlusion = ${railShadow} * (1.0 - 0.4 * exp(-max(toDivider, 0.0) / 0.16));

  // …and under every die: tight and dark when it rests, wide and faint while it is in the air.
  for (int i = 0; i < ${DICE_COUNT}; i++) {
    vec2 axis = uDiceAxis[i];
    vec2 local = p - uDice[i].xy;
    vec2 q = abs(vec2(dot(local, axis), dot(local, vec2(-axis.y, axis.x)))) - ${glsl(DIE_SIZE / 2 - DIE_RADIUS)};
    float distanceToDie = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - ${glsl(DIE_RADIUS * 0.6)};
    float lift = uDice[i].z;
    occlusion *= 1.0 - (0.62 / (1.0 + lift * 5.0)) * exp(-max(distanceToDie, 0.0) / (0.1 + lift * 0.45));
  }

  outgoingLight *= pool * occlusion;
}
`,
    });
  };
  material.customProgramCacheKey = () => (extent ? "farkle-felt-borderless" : "farkle-felt");
  return material;
}

/** The dark wooden table the tray sits on, lit only around the tray. */
export function createTabletopMaterial(): MeshStandardMaterial {
  const wood = getWoodTextures();
  const map = wood.map.clone();
  const normalMap = wood.normalMap.clone();
  for (const texture of [map, normalMap]) {
    // Stretched along the grain so it runs long and straight: a tile covers 40 x 8 world units.
    texture.repeat.set(2, 10);
    texture.needsUpdate = true;
  }
  const material = new MeshStandardMaterial({
    map,
    normalMap,
    normalScale: new Vector2(0.35, 0.35),
    color: "#4a372b",
    roughness: 0.66,
    metalness: 0,
    envMapIntensity: 0.5,
  });

  material.onBeforeCompile = (shader) => {
    extend(shader, {
      declarations: "",
      shading: /* glsl */ `
{
  vec2 p = vSurfaceWorld.xz;
  // A pool of light around the tray that fades into the dark of the room.
  float reach = length(p / vec2(15.0, 12.5));
  float pool = mix(1.0, 0.0, smoothstep(0.3, 1.0, reach));

  // The tray darkens the table right next to it.
  vec2 q = abs(p) - vec2(${glsl(TRAY_WIDTH / 2 + RAIL_THICKNESS)}, ${glsl(TRAY_DEPTH / 2 + RAIL_THICKNESS)});
  float toTray = length(max(q, 0.0));
  float occlusion = 1.0 - 0.55 * exp(-toTray / 0.45);

  outgoingLight *= pool * occlusion;
}
`,
    });
  };
  material.customProgramCacheKey = () => "farkle-tabletop";
  return material;
}

/** Lacquered walnut for the rails and the lane divider. */
export function createWoodMaterial(): MeshPhysicalMaterial {
  const { map, normalMap } = getWoodTextures();
  return new MeshPhysicalMaterial({
    map,
    normalMap,
    normalScale: new Vector2(0.55, 0.55),
    roughness: 0.5,
    metalness: 0,
    // The lacquer is smooth: it keeps the geometric normal while the wood under it has grain.
    clearcoat: 0.6,
    clearcoatRoughness: 0.22,
  });
}
