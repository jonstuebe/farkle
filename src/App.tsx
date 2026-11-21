import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { GameInput } from "./game/machine";
import {
  clearSavedGame,
  createGame,
  loadSavedGame,
  persistGame,
  restoreGame,
  summarizeSavedGame,
  type GameActor,
  type SavedGame,
} from "./game/persistence";
import { AppActionsContext, FarkleContext, type AppActions } from "./game/react";
import { Hud } from "./ui/hud/Hud";
import { SetupScreen } from "./ui/setup/SetupScreen";
import { MuteButton } from "./audio/MuteButton";

// three + rapier are ~1 MB gzipped: keep them out of the first paint and load them on demand.
const loadScene = () => import("./scene/GameCanvas");
const GameCanvas = lazy(() => loadScene().then((m) => ({ default: m.GameCanvas })));

type Screen = { kind: "setup" } | { kind: "playing"; input: GameInput; actor: GameActor; gameId: number };

let nextGameId = 1;

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "setup" });
  const [saved, setSaved] = useState<SavedGame | null>(() => loadSavedGame());

  // Warm the 3D chunk once the setup screen has painted, so Start is (usually) instant.
  useEffect(() => {
    const warm = () => void loadScene().catch(() => {});
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 2500 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 600);
    return () => clearTimeout(id);
  }, []);

  const start = useCallback((input: GameInput) => {
    clearSavedGame();
    setSaved(null);
    setScreen({ kind: "playing", input, actor: createGame(input), gameId: nextGameId++ });
  }, []);

  const resume = useCallback(() => {
    const game = loadSavedGame();
    const actor = game && restoreGame(game);
    if (!game || !actor) {
      clearSavedGame();
      setSaved(null);
      return;
    }
    setScreen({ kind: "playing", input: game.input, actor, gameId: nextGameId++ });
  }, []);

  const newGame = useCallback(() => {
    // A game that is still running was saved on its last change; offer it back on the setup screen.
    setSaved(loadSavedGame());
    setScreen({ kind: "setup" });
  }, []);

  const currentInput = screen.kind === "playing" ? screen.input : null;
  const actions = useMemo<AppActions>(
    () => ({ newGame, playAgain: () => (currentInput ? start(currentInput) : newGame()) }),
    [currentInput, newGame, start],
  );

  const savedSummary = useMemo(() => (saved ? summarizeSavedGame(saved) : null), [saved]);

  return (
    <>
      {screen.kind === "setup" ? (
        <SetupScreen onStart={start} savedGame={savedSummary} onResume={resume} />
      ) : (
        <AppActionsContext.Provider value={actions}>
          <GameView key={screen.gameId} actor={screen.actor} input={screen.input} onNewGame={newGame} />
        </AppActionsContext.Provider>
      )}
      <MuteButton />
    </>
  );
}

interface GameViewProps {
  actor: GameActor;
  input: GameInput;
  onNewGame: () => void;
}

function GameView({ actor, input, onNewGame }: GameViewProps) {
  // Mirror the game into localStorage for as long as this view is mounted.
  useEffect(() => persistGame(actor, input), [actor, input]);

  return (
    <FarkleContext.Provider actor={actor}>
      <div className="app-game">
        <Suspense fallback={<LoadingScreen />}>
          <GameCanvas />
          <Hud onNewGame={onNewGame} />
          <div className="app-curtain" aria-hidden="true" />
        </Suspense>
      </div>
    </FarkleContext.Provider>
  );
}

function LoadingScreen() {
  return (
    <div className="app-loading" role="status" aria-live="polite">
      <svg className="app-loading__die" viewBox="0 0 64 64" aria-hidden="true">
        <rect x="4" y="4" width="56" height="56" rx="13" fill="var(--ivory)" stroke="var(--gold)" strokeWidth="2" />
        <g fill="var(--ink)">
          <circle cx="19" cy="19" r="5" />
          <circle cx="45" cy="19" r="5" />
          <circle cx="32" cy="32" r="5" />
          <circle cx="19" cy="45" r="5" />
          <circle cx="45" cy="45" r="5" />
        </g>
      </svg>
      <p className="app-loading__title">Setting the table…</p>
      <div className="app-loading__bar" aria-hidden="true" />
      <p className="app-loading__hint">Loading the dice and physics</p>
    </div>
  );
}
