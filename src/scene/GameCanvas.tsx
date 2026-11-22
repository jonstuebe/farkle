import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";
import { Table } from "./Table";
import { DiceSet } from "./DiceSet";
import { Lighting, useQualityDpr } from "./Lighting";
import { CameraRig } from "./CameraRig";
import { GRAVITY } from "./tray";

/** The 3D game view: the tray, lighting, and the dice driven by the game machine. */
export function GameCanvas() {
  const dpr = useQualityDpr();
  return (
    <Canvas
      shadows="percentage"
      dpr={dpr}
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
        <DiceSet />
      </Physics>
    </Canvas>
  );
}
