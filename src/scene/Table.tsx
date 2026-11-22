import { useMemo } from "react";
import { CuboidCollider, RigidBody } from "@react-three/rapier";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { createFeltMaterial, createTabletopMaterial, createWoodMaterial } from "./surfaces";
import {
  DIVIDER_HEIGHT,
  DIVIDER_THICKNESS,
  DIVIDER_Z,
  RAIL_HEIGHT,
  RAIL_THICKNESS,
  TRAY_COLLIDERS,
  TRAY_DEPTH,
  TRAY_WIDTH,
} from "./tray";

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
  const { felt, wood, tabletop, longRail, shortRail, divider } = useMemo(() => {
    const railHeight = RAIL_HEIGHT + RAIL_SINK;
    return {
      felt: createFeltMaterial(),
      wood: createWoodMaterial(),
      tabletop: createTabletopMaterial(),
      // Both rail shapes are built long-along-X so the grain follows the rail.
      longRail: new RoundedBoxGeometry(TRAY_WIDTH + RAIL_THICKNESS * 2, railHeight, RAIL_THICKNESS, 4, 0.14),
      shortRail: new RoundedBoxGeometry(TRAY_DEPTH + RAIL_THICKNESS, railHeight, RAIL_THICKNESS, 4, 0.14),
      // Low fence between the play area and the kept-dice lane.
      divider: new RoundedBoxGeometry(TRAY_WIDTH + 0.1, DIVIDER_HEIGHT + RAIL_SINK, DIVIDER_THICKNESS, 3, 0.05),
    };
  }, []);

  const railZ = HALF_D + RAIL_THICKNESS / 2;
  const railX = HALF_W + RAIL_THICKNESS / 2;

  return (
    <>
      {/* Dark wooden tabletop the tray sits on; catches the tray's shadow. */}
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

        <mesh
          castShadow
          receiveShadow
          position={[0, (DIVIDER_HEIGHT - RAIL_SINK) / 2, DIVIDER_Z]}
          geometry={divider}
          material={wood}
        />
        {/* Colliders come from the shared list, which the throw simulation uses too. */}
        {TRAY_COLLIDERS.map((collider, n) => (
          <CuboidCollider
            key={n}
            args={collider.halfExtents}
            position={collider.position}
            friction={collider.friction}
            restitution={collider.restitution}
          />
        ))}
      </RigidBody>
    </>
  );
}
