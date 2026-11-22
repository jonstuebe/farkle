import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { type Mesh, MeshBasicMaterial, PlaneGeometry } from "three";
import { KEEP_LANE_DEPTH, TRAY_DEPTH } from "./tray";

const MARKS = [0, 1, 2, 3, 4] as const;
const OPACITY = 0.3;
const LANE_Z = TRAY_DEPTH / 2 - KEEP_LANE_DEPTH / 2;

/**
 * Faint chalk lines on the felt of the kept-dice lane, one in each gap between two keeps,
 * so dice kept from different rolls read as separate sets. They fade in, and slide along
 * with the dice when the row re-centres.
 */
export function KeptLaneMarks({ dividers }: { dividers: readonly number[] }) {
  const meshes = useRef<(Mesh | null)[]>([]);
  const target = useRef(dividers);
  target.current = dividers;

  const geometry = useMemo(() => new PlaneGeometry(0.035, KEEP_LANE_DEPTH - 0.36), []);
  const materials = useMemo(
    () => MARKS.map(() => new MeshBasicMaterial({ color: "#efe6cf", transparent: true, opacity: 0, depthWrite: false })),
    [],
  );
  useEffect(
    () => () => {
      geometry.dispose();
      materials.forEach((material) => material.dispose());
    },
    [geometry, materials],
  );

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    MARKS.forEach((n) => {
      const mesh = meshes.current[n];
      const material = materials[n]!;
      if (!mesh) return;
      const x = target.current[n];
      const goal = x === undefined ? 0 : OPACITY;
      if (material.opacity === goal && (x === undefined || mesh.position.x === x)) return;
      if (x !== undefined) {
        // A mark that is just appearing starts in place; a visible one slides with the dice.
        if (material.opacity < 0.01) mesh.position.x = x;
        else mesh.position.x += (x - mesh.position.x) * (1 - Math.exp(-delta * 12));
        if (Math.abs(mesh.position.x - x) < 1e-3) mesh.position.x = x;
      }
      material.opacity += (goal - material.opacity) * (1 - Math.exp(-delta * (goal > 0 ? 5 : 14)));
      if (Math.abs(material.opacity - goal) < 0.005) material.opacity = goal;
      mesh.visible = material.opacity > 0;
    });
  });

  return (
    <>
      {MARKS.map((n) => (
        <mesh
          key={n}
          ref={(mesh) => {
            meshes.current[n] = mesh;
          }}
          geometry={geometry}
          material={materials[n]}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[0, 0.006, LANE_Z]}
          visible={false}
          raycast={noRaycast}
        />
      ))}
    </>
  );
}

const noRaycast = () => null;
