import { useMemo } from "react";
import { CuboidCollider, RigidBody } from "@react-three/rapier";
import { MeshPhysicalMaterial, MeshStandardMaterial } from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { getFeltTextures, getWoodTexture } from "./textures";
import { RAIL_HEIGHT, RAIL_THICKNESS, TRAY_DEPTH, TRAY_WIDTH, WALL_HEIGHT } from "./tray";

const FLOOR_THICKNESS = 0.5;
/** How far the rail's base sinks below the felt, hiding the seam. */
const RAIL_SINK = 0.12;
const HALF_W = TRAY_WIDTH / 2;
const HALF_D = TRAY_DEPTH / 2;
const RAIL_Y = (RAIL_HEIGHT - RAIL_SINK) / 2;

/**
 * A felt-lined wooden dice tray. The rail you see is backed by colliders of the same
 * footprint, which continue invisibly upwards so no die can leave the table.
 */
export function Table() {
  const { felt, wood, tabletop, longRail, shortRail } = useMemo(() => {
    const feltTextures = getFeltTextures();
    const woodMap = getWoodTexture();
    const railHeight = RAIL_HEIGHT + RAIL_SINK;
    return {
      felt: new MeshPhysicalMaterial({
        map: feltTextures.map,
        normalMap: feltTextures.normalMap,
        roughness: 1,
        metalness: 0,
        // Sheen gives the soft, velvety rim-light of real baize.
        sheen: 0.6,
        sheenRoughness: 0.75,
        sheenColor: "#4fa878",
        envMapIntensity: 0.3,
      }),
      wood: new MeshPhysicalMaterial({
        map: woodMap,
        roughness: 0.48,
        metalness: 0,
        clearcoat: 0.45,
        clearcoatRoughness: 0.3,
      }),
      tabletop: new MeshStandardMaterial({ color: "#17110d", roughness: 0.85, metalness: 0 }),
      // Both rail shapes are built long-along-X so the grain follows the rail.
      longRail: new RoundedBoxGeometry(TRAY_WIDTH + RAIL_THICKNESS * 2, railHeight, RAIL_THICKNESS, 4, 0.14),
      shortRail: new RoundedBoxGeometry(TRAY_DEPTH + RAIL_THICKNESS, railHeight, RAIL_THICKNESS, 4, 0.14),
    };
  }, []);

  const railZ = HALF_D + RAIL_THICKNESS / 2;
  const railX = HALF_W + RAIL_THICKNESS / 2;

  return (
    <>
      {/* Dark tabletop the tray sits on; catches the tray's shadow. */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -RAIL_SINK, 0]} material={tabletop}>
        <planeGeometry args={[80, 80]} />
      </mesh>

      <RigidBody type="fixed" colliders={false}>
        <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} material={felt}>
          <planeGeometry args={[TRAY_WIDTH, TRAY_DEPTH]} />
        </mesh>

        <mesh castShadow receiveShadow position={[0, RAIL_Y, railZ]} geometry={longRail} material={wood} />
        <mesh castShadow receiveShadow position={[0, RAIL_Y, -railZ]} geometry={longRail} material={wood} />
        <mesh
          castShadow
          receiveShadow
          position={[railX, RAIL_Y, 0]}
          rotation={[0, Math.PI / 2, 0]}
          geometry={shortRail}
          material={wood}
        />
        <mesh
          castShadow
          receiveShadow
          position={[-railX, RAIL_Y, 0]}
          rotation={[0, Math.PI / 2, 0]}
          geometry={shortRail}
          material={wood}
        />

        {/* Felt: soft and grippy. */}
        <CuboidCollider
          args={[HALF_W + RAIL_THICKNESS, FLOOR_THICKNESS / 2, HALF_D + RAIL_THICKNESS]}
          position={[0, -FLOOR_THICKNESS / 2, 0]}
          friction={0.85}
          restitution={0.28}
        />
        {/* Rails: harder and slicker than felt, so dice kick back off them. */}
        <CuboidCollider
          args={[RAIL_THICKNESS / 2, WALL_HEIGHT / 2, HALF_D + RAIL_THICKNESS]}
          position={[railX, WALL_HEIGHT / 2, 0]}
          friction={0.3}
          restitution={0.45}
        />
        <CuboidCollider
          args={[RAIL_THICKNESS / 2, WALL_HEIGHT / 2, HALF_D + RAIL_THICKNESS]}
          position={[-railX, WALL_HEIGHT / 2, 0]}
          friction={0.3}
          restitution={0.45}
        />
        <CuboidCollider
          args={[HALF_W + RAIL_THICKNESS, WALL_HEIGHT / 2, RAIL_THICKNESS / 2]}
          position={[0, WALL_HEIGHT / 2, railZ]}
          friction={0.3}
          restitution={0.45}
        />
        <CuboidCollider
          args={[HALF_W + RAIL_THICKNESS, WALL_HEIGHT / 2, RAIL_THICKNESS / 2]}
          position={[0, WALL_HEIGHT / 2, -railZ]}
          friction={0.3}
          restitution={0.45}
        />
        {/* Lid, in case of a freak bounce. */}
        <CuboidCollider
          args={[HALF_W + RAIL_THICKNESS, 0.25, HALF_D + RAIL_THICKNESS]}
          position={[0, WALL_HEIGHT + 0.25, 0]}
        />
      </RigidBody>
    </>
  );
}
