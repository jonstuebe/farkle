import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { RigidBody, type RapierRigidBody } from "@react-three/rapier";
import {
  BackSide,
  Color,
  Euler,
  type Group,
  type Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  Quaternion,
  Vector2,
  Vector3,
} from "three";
import { DIE_SIZE, topFace, type DieValue } from "./dice";
import { squareUpQuaternion, type Vec3 } from "./diceLayout";
import { IS_TOUCH } from "./touch";
import { clearDiceOccluder, setDiceOccluder } from "./surfaces";
import { getDiceTextures, getDieGeometry } from "./textures";

const SELECT_LIFT = 0.2;
/**
 * Drawn larger (about 14%) on touch screens, where dice are small under a fingertip. Visual only:
 * the throw simulation and layout still use DIE_SIZE.
 */
export const DIE_DISPLAY_SCALE = IS_TOUCH ? 1.144 : 1;
/** Raise the scaled die so it still sits on the felt rather than sinking into it. */
const SCALE_LIFT = (DIE_SIZE * (DIE_DISPLAY_SCALE - 1)) / 2;
const HIGHLIGHT = new Color("#ffb53a");
const DIM = new Color(0.4, 0.4, 0.43);
const WHITE = new Color(1, 1, 1);

let sharedMaterial: MeshPhysicalMaterial | undefined;
/** Polished ivory resin: soft body, thin glossy lacquer on top. Cloned per die for tinting. */
function getDieMaterial() {
  if (!sharedMaterial) {
    const { map, normalMap } = getDiceTextures();
    sharedMaterial = new MeshPhysicalMaterial({
      map,
      normalMap,
      normalScale: new Vector2(1, 1),
      roughness: 0.42,
      metalness: 0,
      clearcoat: 0.7,
      clearcoatRoughness: 0.16,
      clearcoatNormalMap: normalMap,
      clearcoatNormalScale: new Vector2(0.6, 0.6),
      envMapIntensity: 1,
    });
  }
  return sharedMaterial;
}

export interface DieReading {
  /** Being carried (to a slot, to the waiting row, or into the hand before a throw). */
  gliding: boolean;
  /** The face it shows right now. */
  value: DieValue;
  /** Where its centre is. */
  position: Vec3;
}

export interface GlideOptions {
  /** Target orientation; "square" = current top face, levelled and turned square. */
  orientation: Quaternion | "square";
  duration: number;
  /** Extra height at the middle of the move, so dice hop over the divider and each other. */
  arc: number;
}

/** Imperative control used by DiceSet, which owns the game flow. */
export interface DieHandle {
  /** False until the body exists. */
  ready(): boolean;
  /** Carry the die to a pose over time. */
  glideTo(position: Vec3, options: GlideOptions): void;
  /** Follow a recorded throw: move to this pose by the next frame. Cancels any glide. */
  track(position: Vector3, rotation: Quaternion): void;
  /** Put the die at a pose right now. Cancels any glide. */
  place(position: Vec3 | Vector3, orientation: Quaternion | "square"): void;
  read(): DieReading;
}

export interface DieProps {
  index: number;
  ref?: Ref<DieHandle>;
  initialPosition: Vec3;
  /** Tappable right now (DiceSet does the picking; this drives the cursor). */
  interactive?: boolean;
  selected?: boolean;
  /** Greyed out (farkle). */
  dimmed?: boolean;
}

interface Glide {
  fromPosition: Vector3;
  fromRotation: Quaternion;
  toPosition: Vector3;
  toRotation: Quaternion;
  arc: number;
  duration: number;
  elapsed: number;
}

const _position = new Vector3();
const _rotation = new Quaternion();
const _up = new Vector3();

/**
 * One die. It has no game logic and no physics of its own: DiceSet tells it where to be
 * (carried moves, or frame-by-frame playback of a simulated throw) and it reports what it
 * shows. The body is kinematic, so the renderer interpolates it like any other body.
 */
export function Die({ index, ref, initialPosition, interactive = false, selected = false, dimmed = false }: DieProps) {
  const body = useRef<RapierRigidBody>(null);
  const visual = useRef<Group>(null);
  const outline = useRef<Mesh>(null);
  const glide = useRef<Glide | null>(null);
  const highlight = useRef(0);
  const dim = useRef(0);
  const [hovered, setHovered] = useState(false);
  const canvas = useThree((state) => state.gl.domElement);

  const material = useMemo(() => getDieMaterial().clone(), []);
  const outlineMaterial = useMemo(
    () => new MeshBasicMaterial({ color: HIGHLIGHT, side: BackSide, toneMapped: false, transparent: true, opacity: 0 }),
    [],
  );
  // Stable identity so the physics wrapper never re-applies the spawn pose.
  const spawn = useMemo(() => initialPosition, []); // eslint-disable-line react-hooks/exhaustive-deps

  useImperativeHandle(
    ref,
    (): DieHandle => ({
      ready: () => body.current !== null,
      glideTo(position, options) {
        const rigidBody = body.current;
        if (!rigidBody) return;
        const t = rigidBody.translation();
        const r = rigidBody.rotation();
        glide.current = {
          fromPosition: new Vector3(t.x, t.y, t.z),
          fromRotation: new Quaternion(r.x, r.y, r.z, r.w),
          toPosition: new Vector3(...position),
          toRotation: options.orientation === "square" ? squareUpQuaternion(r) : options.orientation.clone(),
          arc: options.arc,
          duration: Math.max(options.duration, 1e-3),
          elapsed: 0,
        };
      },
      track(position, rotation) {
        const rigidBody = body.current;
        if (!rigidBody) return;
        glide.current = null;
        rigidBody.setNextKinematicTranslation(position);
        rigidBody.setNextKinematicRotation(rotation);
      },
      place(position, orientation) {
        const rigidBody = body.current;
        if (!rigidBody) return;
        glide.current = null;
        const [x, y, z] = Array.isArray(position) ? position : [position.x, position.y, position.z];
        const rotation = orientation === "square" ? squareUpQuaternion(rigidBody.rotation()) : orientation;
        rigidBody.setTranslation({ x, y, z }, true);
        rigidBody.setRotation(rotation, true);
        // Also cancel any move still queued from the previous frame.
        rigidBody.setNextKinematicTranslation({ x, y, z });
        rigidBody.setNextKinematicRotation(rotation);
      },
      read() {
        const rigidBody = body.current;
        if (!rigidBody) return { gliding: true, value: 1, position: [0, 0, 0] };
        const t = rigidBody.translation();
        return { gliding: glide.current !== null, value: topFace(rigidBody.rotation()), position: [t.x, t.y, t.z] };
      },
    }),
    [],
  );

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const rigidBody = body.current;

    // --- carried moves ---
    const g = glide.current;
    if (g && rigidBody) {
      g.elapsed += delta;
      const t = Math.min(g.elapsed / g.duration, 1);
      const k = t * t * (3 - 2 * t);
      if (t < 1) {
        _position.lerpVectors(g.fromPosition, g.toPosition, k);
        _position.y += g.arc * Math.sin(Math.PI * k);
        _rotation.slerpQuaternions(g.fromRotation, g.toRotation, k);
        rigidBody.setNextKinematicTranslation(_position);
        rigidBody.setNextKinematicRotation(_rotation);
      } else {
        glide.current = null;
        rigidBody.setNextKinematicTranslation(g.toPosition);
        rigidBody.setNextKinematicRotation(g.toRotation);
      }
    }

    // --- selection highlight / farkle dim (visual only; the body doesn't move) ---
    const ease = 1 - Math.exp(-delta * 14);
    highlight.current += ((selected ? 1 : 0) - highlight.current) * ease;
    dim.current += ((dimmed ? 1 : 0) - dim.current) * (1 - Math.exp(-delta * 5));
    const h = highlight.current;
    const group = visual.current;
    if (group?.parent) {
      // World-up expressed in the die's own frame, so the lift is always straight up.
      _up.set(0, 1, 0).applyQuaternion(_rotation.copy(group.parent.quaternion).invert());
      group.position.copy(_up).multiplyScalar(h * SELECT_LIFT + SCALE_LIFT);
      // Tell the felt where this die is, so it can shade the cloth underneath.
      setDiceOccluder(index, group.parent.position, group.parent.quaternion, h * SELECT_LIFT + SCALE_LIFT);
    }
    material.emissive.copy(HIGHLIGHT);
    material.emissiveIntensity = h * 0.16;
    material.color.copy(WHITE).lerp(DIM, dim.current);
    const hull = outline.current;
    if (hull) {
      hull.visible = h > 0.02;
      hull.scale.setScalar(1 + 0.09 * h);
      outlineMaterial.opacity = Math.min(1, h * 1.2);
    }
  });

  // Cursor feedback on desktop.
  const pointing = hovered && interactive;
  useEffect(() => {
    if (!pointing) return;
    canvas.style.cursor = "pointer";
    return () => {
      canvas.style.cursor = "";
    };
  }, [pointing, canvas]);

  useEffect(
    () => () => {
      material.dispose();
      outlineMaterial.dispose();
      clearDiceOccluder(index);
    },
    [material, outlineMaterial, index],
  );

  return (
    <RigidBody
      ref={body}
      type="kinematicPosition"
      colliders={false}
      position={spawn}
      rotation={SPAWN_ROTATION}
    >
      <group ref={visual} scale={DIE_DISPLAY_SCALE}>
        <mesh
          geometry={getDieGeometry()}
          material={material}
          castShadow
          receiveShadow
          onPointerOver={(event) => {
            event.stopPropagation();
            setHovered(true);
          }}
          onPointerOut={() => setHovered(false)}
        />
        {/* Inverted hull: a crisp rim that shows only when selected. */}
        <mesh ref={outline} geometry={getDieGeometry()} material={outlineMaterial} visible={false} raycast={noRaycast} />
      </group>
    </RigidBody>
  );
}

const SPAWN_ROTATION = new Euler(0, 0, 0);
const noRaycast = () => null;
