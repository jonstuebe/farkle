import { CuboidCollider, RigidBody } from "@react-three/rapier";

const SIZE = 10;
const WALL_HEIGHT = 2;

/** Felt floor plus invisible walls that keep the dice on screen. */
export function Table() {
  const half = SIZE / 2;
  return (
    <RigidBody type="fixed" friction={0.8} restitution={0.3}>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[SIZE, SIZE]} />
        <meshStandardMaterial color="#1f5c3a" />
      </mesh>
      <CuboidCollider args={[half, 0.1, half]} position={[0, -0.1, 0]} />
      <CuboidCollider args={[0.1, WALL_HEIGHT, half]} position={[half, WALL_HEIGHT, 0]} />
      <CuboidCollider args={[0.1, WALL_HEIGHT, half]} position={[-half, WALL_HEIGHT, 0]} />
      <CuboidCollider args={[half, WALL_HEIGHT, 0.1]} position={[0, WALL_HEIGHT, half]} />
      <CuboidCollider args={[half, WALL_HEIGHT, 0.1]} position={[0, WALL_HEIGHT, -half]} />
    </RigidBody>
  );
}
