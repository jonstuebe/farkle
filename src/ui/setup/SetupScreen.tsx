import type { GameInput } from "../../game/machine";

export interface SetupScreenProps {
  onStart: (input: GameInput) => void;
}

/** Pre-game screen: players and rule options. STUB: starts a two-player game. */
export function SetupScreen({ onStart }: SetupScreenProps) {
  return (
    <div className="hud">
      <button onClick={() => onStart({ players: ["Player 1", "Player 2"] })}>Start game</button>
    </div>
  );
}
