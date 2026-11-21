import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import type { GameInput } from "./game/machine";
import { clearSavedGame, loadSavedGame, persistSession, summarizeSavedGame, type SavedGame } from "./game/persistence";
import { AppActionsContext, GameProvider, type AppActions } from "./game/react";
import { createLocalSession, type GameSession } from "./game/session";
import { Presenter } from "./game/presenter";
import { Hud } from "./ui/hud/Hud";
import { SetupScreen } from "./ui/setup/SetupScreen";
import { MuteButton } from "./audio/MuteButton";

// three + rapier are ~1 MB gzipped: keep them out of the first paint and load them on demand.
const loadScene = () => import("./scene/GameCanvas");
const GameCanvas = lazy(() => loadScene().then((m) => ({ default: m.GameCanvas })));

type Screen =
  | { kind: "setup" }
  | { kind: "playing"; input: GameInput; session: GameSession; presenter: Presenter; gameId: number };

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

  // Session + presenter are created in event handlers (never during render, so StrictMode can't
  // double them) and the previous game's presenter is stopped when the screen changes.
  const show = useCallback((next: Screen) => {
    setScreen((current) => {
      if (current.kind === "playing" && current !== next) current.presenter.stop();
      return next;
    });
  }, []);

  const open = useCallback(
    (input: GameInput, saved?: SavedGame) => {
      const session = createLocalSession({ input, log: saved?.log ?? [] });
      show({ kind: "playing", input, session, presenter: new Presenter(session), gameId: nextGameId++ });
    },
    [show],
  );

  const start = useCallback(
    (input: GameInput) => {
      clearSavedGame();
      setSaved(null);
      open(input);
    },
    [open],
  );

  const resume = useCallback(() => {
    const game = loadSavedGame();
    if (!game) {
      clearSavedGame();
      setSaved(null);
      return;
    }
    open(game.input, game);
  }, [open]);

  const newGame = useCallback(() => {
    // A game that is still running was saved on its last change; offer it back on the setup screen.
    setSaved(loadSavedGame());
    show({ kind: "setup" });
  }, [show]);

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
          <GameView key={screen.gameId} session={screen.session} presenter={screen.presenter} onNewGame={newGame} />
        </AppActionsContext.Provider>
      )}
      <MuteButton />
    </>
  );
}

interface GameViewProps {
  session: GameSession;
  presenter: Presenter;
  onNewGame: () => void;
}

function GameView({ session, presenter, onNewGame }: GameViewProps) {
  // Mirror the local game into localStorage for as long as this view is mounted.
  useEffect(() => (session.kind === "local" ? persistSession(session) : undefined), [session]);

  return (
    <GameProvider session={session} presenter={presenter}>
      <div className="app-game">
        <Suspense fallback={<LoadingScreen />}>
          <GameCanvas />
          <Hud onNewGame={onNewGame} />
          <div className="app-curtain" aria-hidden="true" />
        </Suspense>
      </div>
    </GameProvider>
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
