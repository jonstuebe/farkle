import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { ACESFilmicToneMapping, SRGBColorSpace } from "three";
import { Table } from "./scene/Table";
import { Die } from "./scene/Die";
import { CameraRig, Lighting } from "./scene/Lighting";
import { GRAVITY } from "./scene/tray";

const DICE_COUNT = 6;

export function App() {
  // Bumping this remounts the dice, which re-throws them.
  const [rollId, setRollId] = useState(0);

  return (
    <>
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
          {Array.from({ length: DICE_COUNT }, (_, i) => (
            <Die key={`${rollId}-${i}`} index={i} />
          ))}
        </Physics>
      </Canvas>
      <div className="hud">
        <button onClick={() => setRollId((n) => n + 1)}>Roll</button>
      </div>
    </>
  );
}
