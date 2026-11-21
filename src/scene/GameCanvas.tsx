import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";
import { Table } from "./Table";
import { Die } from "./Die";
import { Lighting } from "./Lighting";
import { CameraRig } from "./CameraRig";
import { GRAVITY } from "./tray";

/**
 * The 3D game view. STUB: renders six free dice; the scene worker replaces the dice with a
 * game-driven dice set (see the scene task spec).
 */
export function GameCanvas() {
  return (
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ position: [0, 11, 7.5], fov: 40, near: 0.5, far: 200 }}
      gl={{ antialias: true, powerPreference: "high-performance" }}
      onCreated={({ gl }) => {
        gl.toneMapping = ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.05;
        gl.outputColorSpace = SRGBColorSpace;
      }}
    >
      <color attach="background" args={["#0b0907"]} />
      <CameraRig />
      <Lighting />
      <Physics gravity={GRAVITY}>
        <Table />
        {Array.from({ length: 6 }, (_, i) => (
          <Die key={i} index={i} />
        ))}
      </Physics>
    </Canvas>
  );
}
