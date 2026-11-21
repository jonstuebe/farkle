import { useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Physics } from "@react-three/rapier";
import { Table } from "./scene/Table";
import { Die } from "./scene/Die";

const DICE_COUNT = 6;

export function App() {
  // Bumping this remounts the dice, which re-throws them.
  const [rollId, setRollId] = useState(0);

  return (
    <>
      <Canvas shadows camera={{ position: [0, 9, 7], fov: 45 }}>
        <ambientLight intensity={0.5} />
        <directionalLight castShadow position={[4, 10, 4]} intensity={1.5} shadow-mapSize={[1024, 1024]} />
        <Physics>
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
