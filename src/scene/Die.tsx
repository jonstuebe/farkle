import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { RigidBody, RoundCuboidCollider, type RapierRigidBody } from "@react-three/rapier";
import { MeshPhysicalMaterial, Vector2 } from "three";
import { DIE_RADIUS, DIE_SIZE, topFace, type DieValue } from "./dice";
import { getDiceTextures, getDieGeometry } from "./textures";
import { TRAY_WIDTH } from "./tray";

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

/** A die counts as settled after staying below both speeds for this long. */
const SETTLE_LINEAR_SPEED = 0.06;
const SETTLE_ANGULAR_SPEED = 0.12;
const SETTLE_SECONDS = 0.3;

const CORE = DIE_SIZE / 2 - DIE_RADIUS;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const randSigned = (min: number, max: number) => rand(min, max) * (Math.random() < 0.5 ? -1 : 1);

let sharedMaterial: MeshPhysicalMaterial | undefined;
/** Polished ivory resin: soft body, thin glossy lacquer on top. Shared by all dice. */
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

export interface DieProps {
  index: number;
  /** Fired once per mount, when the die has come to rest, with the face pointing up. */
  onSettle?: (value: DieValue) => void;
}

/** A single physics die, thrown from the left side of the tray when mounted. */
export function Die({ index, onSettle }: DieProps) {
  const body = useRef<RapierRigidBody>(null);
  const onSettleRef = useRef(onSettle);
  useEffect(() => {
    onSettleRef.current = onSettle;
  }, [onSettle]);
  const settled = useRef(false);
  const stillFor = useRef(0);

  // Randomize the throw once per mount: the dice leave a loose 2x3 "handful" near the
  // left rail, travelling right and slightly down with plenty of tumble.
  const throwParams = useMemo(() => {
    const col = index % 3;
    const row = Math.floor(index / 3) % 2;
    return {
      position: [
        -TRAY_WIDTH / 2 + 1.1 + row * 1.05 + rand(-0.08, 0.08),
        2.1 + ((index * 7) % 3) * 0.45 + rand(0, 0.3),
        (col - 1) * 1.1 + 0.4 + rand(-0.1, 0.1),
      ],
      rotation: [rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2)],
      linearVelocity: [rand(6.5, 10), rand(-2, 0.5), rand(-2.6, 2.2)],
      angularVelocity: [randSigned(4, 14), randSigned(4, 14), randSigned(6, 16)],
    } satisfies Record<string, [number, number, number]>;
  }, [index]);

  const report = () => {
    const rigidBody = body.current;
    if (settled.current || !rigidBody) return;
    settled.current = true;
    onSettleRef.current?.(topFace(rigidBody.rotation()));
  };

  useFrame((_, delta) => {
    const rigidBody = body.current;
    if (settled.current || !rigidBody) return;
    if (rigidBody.isSleeping()) return report();
    const v = rigidBody.linvel();
    const w = rigidBody.angvel();
    const still =
      Math.hypot(v.x, v.y, v.z) < SETTLE_LINEAR_SPEED && Math.hypot(w.x, w.y, w.z) < SETTLE_ANGULAR_SPEED;
    stillFor.current = still ? stillFor.current + delta : 0;
    if (stillFor.current >= SETTLE_SECONDS) report();
  });

  return (
    <RigidBody
      ref={body}
      colliders={false}
      position={throwParams.position}
      rotation={throwParams.rotation}
      linearVelocity={throwParams.linearVelocity}
      angularVelocity={throwParams.angularVelocity}
      linearDamping={PHYSICS.linearDamping}
      angularDamping={PHYSICS.angularDamping}
      ccd
      onSleep={report}
    >
      {/* Core box + border radius = exactly the rounded mesh below. */}
      <RoundCuboidCollider
        args={[CORE, CORE, CORE, DIE_RADIUS]}
        friction={PHYSICS.friction}
        restitution={PHYSICS.restitution}
        density={PHYSICS.density}
      />
      <mesh geometry={getDieGeometry()} material={getDieMaterial()} castShadow receiveShadow />
    </RigidBody>
  );
}
