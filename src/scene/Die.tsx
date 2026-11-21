import { useMemo } from "react";
import { RoundedBox } from "@react-three/drei";
import { CuboidCollider, RigidBody } from "@react-three/rapier";

const SIZE = 0.8;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** A single physics die, thrown from the side of the table when mounted. */
export function Die({ index }: { index: number }) {
  // Randomize the throw once per mount.
  const throwParams = useMemo(
    () => ({
      position: [-3 + rand(-0.5, 0.5), 3 + index * 0.6, 2 + rand(-1, 1)] as const,
      rotation: [rand(0, Math.PI * 2), rand(0, Math.PI * 2), rand(0, Math.PI * 2)] as const,
      linearVelocity: [rand(5, 8), 0, rand(-4, -2)] as const,
      angularVelocity: [rand(-15, 15), rand(-15, 15), rand(-15, 15)] as const,
    }),
    [index],
  );

  return (
    <RigidBody
      colliders={false}
      position={[...throwParams.position]}
      rotation={[...throwParams.rotation]}
      linearVelocity={[...throwParams.linearVelocity]}
      angularVelocity={[...throwParams.angularVelocity]}
      friction={0.6}
      restitution={0.35}
    >
      <CuboidCollider args={[SIZE / 2, SIZE / 2, SIZE / 2]} />
      <RoundedBox args={[SIZE, SIZE, SIZE]} radius={0.08} smoothness={4} castShadow>
        <meshStandardMaterial color="#f4f1e8" />
      </RoundedBox>
    </RigidBody>
  );
}
