import { useState } from "react";
import type { GameInput } from "./game/machine";
import { FarkleContext } from "./game/react";
import { GameCanvas } from "./scene/GameCanvas";
import { Hud } from "./ui/hud/Hud";
import { SetupScreen } from "./ui/setup/SetupScreen";
import { MuteButton } from "./audio/MuteButton";

type Screen = { kind: "setup" } | { kind: "playing"; input: GameInput; gameId: number };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "setup" });

  return (
    <>
      {screen.kind === "setup" ? (
        <SetupScreen onStart={(input) => setScreen({ kind: "playing", input, gameId: Date.now() })} />
      ) : (
        <FarkleContext.Provider key={screen.gameId} options={{ input: screen.input }}>
          <GameCanvas />
          <Hud onNewGame={() => setScreen({ kind: "setup" })} />
        </FarkleContext.Provider>
      )}
      <MuteButton />
    </>
  );
}
