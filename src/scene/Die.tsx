import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import {
  RigidBody,
  RoundCuboidCollider,
  type ContactForcePayload,
  type RapierRigidBody,
} from "@react-three/rapier";
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
import { playDiceHit } from "../audio/sfx";
import { DIE_RADIUS, DIE_SIZE, topFace, topFaceAlignment, type DieValue } from "./dice";
import { impactStrength, levelQuaternion, REST_Y, squareUpQuaternion, type Throw, type Vec3 } from "./diceLayout";
import { getDiceTextures, getDieGeometry } from "./textures";
import { PLAY_CENTER_Z } from "./tray";

/** Physics tuning. Values are paired with GRAVITY in ./tray. */
const PHYSICS = {
  /** Resin on felt: grippy enough to roll rather than slide, without tripping over. */
  friction: 0.42,
  /** Lively first bounce that dies out within two or three hops. */
  restitution: 0.32,
  /** Bleeds off the long, slow final wobble without making the flight look floaty. */
  linearDamping: 0.12,
  angularDamping: 0.28,
  /** Relative weight only (nothing else is dynamic), kept ~1 for solver stability. */
  density: 1.2,
} as const;

/** A die counts as still below both of these speeds. */
const STILL_LINEAR_SPEED = 0.06;
const STILL_ANGULAR_SPEED = 0.12;

/** Rapier's RigidBodyType enum values (kept numeric to avoid importing the wasm package here). */
const BODY_DYNAMIC = 0;
const BODY_KINEMATIC = 2;
const PHYSICS_STEP = 1 / 60;
/** At most one hit sound per die in this many milliseconds. */
const HIT_INTERVAL_MS = 70;

const CORE = DIE_SIZE / 2 - DIE_RADIUS;
const SELECT_LIFT = 0.2;
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
  /** Not gliding and effectively motionless. */
  still: boolean;
  value: DieValue;
  /** See topFaceAlignment. */
  alignment: number;
  /** Height of the die's centre. */
  y: number;
}

export interface GlideOptions {
  /** Target orientation; "square" = current top face, levelled and turned square. */
  orientation: Quaternion | "square";
  duration: number;
  /** Extra height at the middle of the move, so dice hop over the divider and each other. */
  arc: number;
  /** If set, the die is released as a free body with these velocities on arrival. */
  launch?: Pick<Throw, "linearVelocity" | "angularVelocity">;
}

/** Imperative control used by DiceSet, which owns the game flow. */
export interface DieHandle {
  /** False until the physics body exists. */
  ready(): boolean;
  /** Carry the die to a pose. While carried it passes through everything. */
  glideTo(position: Vec3, options: GlideOptions): void;
  /** Stop the die where it is and make it immovable, optionally levelling a tilted die. */
  freeze(level: boolean): void;
  /** Kick a stuck (cocked / stacked) die back towards the middle of the play area. */
  nudge(): void;
  read(): DieReading;
}

export interface DieProps {
  index: number;
  ref?: Ref<DieHandle>;
  initialPosition: Vec3;
  /** Clickable right now. */
  interactive?: boolean;
  selected?: boolean;
  /** Greyed out (farkle). */
  dimmed?: boolean;
  onToggle?: (index: number) => void;
}

interface Glide {
  fromPosition: Vector3;
  fromRotation: Quaternion;
  toPosition: Vector3;
  toRotation: Quaternion;
  arc: number;
  duration: number;
  elapsed: number;
  launch?: GlideOptions["launch"];
}

const _position = new Vector3();
const _rotation = new Quaternion();
const _up = new Vector3();

/**
 * One physics die. It has no game logic: DiceSet tells it where to go and when to fly,
 * and it reports what it shows.
 */
export function Die({ index, ref, initialPosition, interactive = false, selected = false, dimmed = false, onToggle }: DieProps) {
  const body = useRef<RapierRigidBody>(null);
  const visual = useRef<Group>(null);
  const outline = useRef<Mesh>(null);
  const glide = useRef<Glide | null>(null);
  const highlight = useRef(0);
  const dim = useRef(0);
  const lastHit = useRef(0);
  const [hovered, setHovered] = useState(false);
  const canvas = useThree((state) => state.gl.domElement);

  const material = useMemo(() => getDieMaterial().clone(), []);
  const outlineMaterial = useMemo(
    () => new MeshBasicMaterial({ color: HIGHLIGHT, side: BackSide, toneMapped: false, transparent: true, opacity: 0 }),
    [],
  );
  // Stable identity so the physics wrapper never re-applies the spawn pose.
  const spawn = useMemo(() => initialPosition, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setSensor = (sensor: boolean) => {
    const rigidBody = body.current;
    if (!rigidBody) return;
    for (let i = 0; i < rigidBody.numColliders(); i++) rigidBody.collider(i).setSensor(sensor);
  };

  const makeKinematic = () => {
    const rigidBody = body.current;
    if (!rigidBody) return;
    rigidBody.setLinvel({ x: 0, y: 0, z: 0 }, false);
    rigidBody.setAngvel({ x: 0, y: 0, z: 0 }, false);
    if (rigidBody.bodyType() !== BODY_KINEMATIC) rigidBody.setBodyType(BODY_KINEMATIC, true);
  };

  useImperativeHandle(
    ref,
    (): DieHandle => ({
      ready: () => body.current !== null,
      glideTo(position, options) {
        const rigidBody = body.current;
        if (!rigidBody) return;
        const t = rigidBody.translation();
        const r = rigidBody.rotation();
        makeKinematic();
        setSensor(true);
        glide.current = {
          fromPosition: new Vector3(t.x, t.y, t.z),
          fromRotation: new Quaternion(r.x, r.y, r.z, r.w),
          toPosition: new Vector3(...position),
          toRotation: options.orientation === "square" ? squareUpQuaternion(r) : options.orientation.clone(),
          arc: options.arc,
          duration: Math.max(options.duration, 1e-3),
          elapsed: 0,
          launch: options.launch,
        };
      },
      freeze(level) {
        const rigidBody = body.current;
        if (!rigidBody || glide.current) return;
        makeKinematic();
        const t = rigidBody.translation();
        // Only level a die that is actually on the felt; one resting on another die stays put.
        if (level && t.y < REST_Y + 0.2) {
          rigidBody.setRotation(levelQuaternion(rigidBody.rotation()), true);
          rigidBody.setTranslation({ x: t.x, y: REST_Y, z: t.z }, true);
        }
      },
      nudge() {
        const rigidBody = body.current;
        if (!rigidBody || glide.current || rigidBody.bodyType() !== BODY_DYNAMIC) return;
        const t = rigidBody.translation();
        const mass = rigidBody.mass();
        _position.set(-t.x, 0, PLAY_CENTER_Z - t.z);
        if (_position.lengthSq() < 0.01) _position.set(Math.random() - 0.5, 0, Math.random() - 0.5);
        _position.normalize().multiplyScalar(2.6);
        rigidBody.applyImpulse({ x: _position.x * mass, y: 6.5 * mass, z: _position.z * mass }, true);
        const spin = () => (Math.random() - 0.5) * 0.9 * mass;
        rigidBody.applyTorqueImpulse({ x: spin(), y: spin(), z: spin() }, true);
      },
      read() {
        const rigidBody = body.current;
        if (!rigidBody) return { gliding: true, still: false, value: 1, alignment: 0, y: 0 };
        const rotation = rigidBody.rotation();
        const gliding = glide.current !== null;
        let still = !gliding;
        if (still && rigidBody.bodyType() === BODY_DYNAMIC && !rigidBody.isSleeping()) {
          const v = rigidBody.linvel();
          const w = rigidBody.angvel();
          still =
            Math.hypot(v.x, v.y, v.z) < STILL_LINEAR_SPEED && Math.hypot(w.x, w.y, w.z) < STILL_ANGULAR_SPEED;
        }
        return {
          gliding,
          still,
          value: topFace(rotation),
          alignment: topFaceAlignment(rotation),
          y: rigidBody.translation().y,
        };
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        if (g.launch) rigidBody.setBodyType(BODY_DYNAMIC, true);
        rigidBody.setTranslation(g.toPosition, true);
        rigidBody.setRotation(g.toRotation, true);
        if (g.launch) {
          const [vx, vy, vz] = g.launch.linearVelocity;
          const [wx, wy, wz] = g.launch.angularVelocity;
          rigidBody.setLinvel({ x: vx, y: vy, z: vz }, true);
          rigidBody.setAngvel({ x: wx, y: wy, z: wz }, true);
        }
        setSensor(false);
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
      group.position.copy(_up).multiplyScalar(h * SELECT_LIFT);
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

  // Hit sounds: contact force -> velocity change -> 0..1 strength.
  const onContactForce = (payload: ContactForcePayload) => {
    const rigidBody = body.current;
    if (!rigidBody || rigidBody.bodyType() !== BODY_DYNAMIC) return;
    const other = payload.other.rigidBody;
    const otherDie = payload.other.rigidBodyObject?.userData?.dieIndex as number | undefined;
    // For die-on-die contacts both dice get the event; let the lower index report it.
    if (otherDie !== undefined && otherDie < index && other?.bodyType() === BODY_DYNAMIC) return;
    const now = performance.now();
    if (now - lastHit.current < HIT_INTERVAL_MS) return;
    const strength = impactStrength((payload.totalForceMagnitude * PHYSICS_STEP) / rigidBody.mass());
    if (strength <= 0) return;
    lastHit.current = now;
    const surface =
      otherDie !== undefined ? "die" : Math.abs(payload.maxForceDirection.y) > 0.7 ? "felt" : "wood";
    playDiceHit(strength, surface);
  };

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
    },
    [material, outlineMaterial],
  );

  const onClick = (event: ThreeEvent<MouseEvent>) => {
    if (!interactive) return;
    event.stopPropagation();
    // `delta` is how far the pointer travelled between down and up: ignore drags.
    if (event.delta > 8) return;
    onToggle?.(index);
  };

  return (
    <RigidBody
      ref={body}
      type="kinematicPosition"
      colliders={false}
      position={spawn}
      rotation={SPAWN_ROTATION}
      linearDamping={PHYSICS.linearDamping}
      angularDamping={PHYSICS.angularDamping}
      ccd
      userData={{ dieIndex: index }}
      onContactForce={onContactForce}
    >
      {/* Core box + border radius = exactly the rounded mesh below. */}
      <RoundCuboidCollider
        args={[CORE, CORE, CORE, DIE_RADIUS]}
        friction={PHYSICS.friction}
        restitution={PHYSICS.restitution}
        density={PHYSICS.density}
      />
      <group ref={visual}>
        <mesh
          geometry={getDieGeometry()}
          material={material}
          castShadow
          receiveShadow
          onClick={onClick}
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
