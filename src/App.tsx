import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { GameInput } from "./game/machine";
import {
  BOT_SAVE_KEY,
  SAVE_KEY,
  clearSavedGame,
  loadSavedGame,
  persistSession,
  summarizeSavedGame,
  type SavedGame,
} from "./game/persistence";
import { driveBots } from "./game/bot";
import { AppActionsContext, GameProvider, type AppActions } from "./game/react";
import { createLocalSession, type GameSession } from "./game/session";
import { replayLog } from "./game/log";
import { Presenter } from "./game/presenter";
import { getDeviceId, getPlayerName, setPlayerName } from "./net/device";
import { newRoomCode } from "./net/protocol";
import { createRouter, type Route, type Router } from "./net/routes";
import { Hud } from "./ui/hud/Hud";
import { SetupScreen } from "./ui/setup/SetupScreen";
import { HomeScreen } from "./ui/online/HomeScreen";
import { JoinScreen } from "./ui/online/JoinScreen";
import { NameScreen } from "./ui/online/NameScreen";
import { RoomScreen, type OnlineGame } from "./ui/online/RoomScreen";
import { MuteButton } from "./audio/MuteButton";

// three + rapier are ~1 MB gzipped: keep them out of the first paint and load them on demand.
const loadScene = () => import("./scene/GameCanvas");
const GameCanvas = lazy(() => loadScene().then((m) => ({ default: m.GameCanvas })));

/**
 * The scene dispatches this on `window` once Rapier's WASM is initialised and the tray has
 * rendered. <Physics> suspends inside the canvas, where the Suspense below can't see it, so
 * without the event the loading screen went away before the table could be drawn.
 */
// Same string as SCENE_READY_EVENT in scene/DiceSet.tsx (not imported: that would pull three into this chunk).
const SCENE_READY_EVENT = "farkle:scene-ready";
/** Never keep the player on the loading screen forever if the event doesn't come. */
const SCENE_READY_TIMEOUT_MS = 8000;

function useSceneReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const done = () => setReady(true);
    window.addEventListener(SCENE_READY_EVENT, done);
    const timer = setTimeout(done, SCENE_READY_TIMEOUT_MS);
    return () => {
      window.removeEventListener(SCENE_READY_EVENT, done);
      clearTimeout(timer);
    };
  }, []);
  return ready;
}

/**
 * Screens, by route (see ./net/routes.ts):
 *   /          home, and under it (history state) local play, play against bots and the join form
 *   /r/CODE    an online room: naming (first time), lobby, then the game
 */
const router: Router = createRouter(window);

const HOME: Route = { kind: "home" };

export function App() {
  const route = useSyncExternalStore(router.subscribe, router.getRoute);
  const deviceId = useMemo(() => getDeviceId(), []);
  const [name, setName] = useState<string | null>(() => getPlayerName());
  const [editingName, setEditingName] = useState(false);
  // Read again whenever home is shown, so a local game played since then is offered.
  const localGame = useMemo(() => {
    const saved = route.kind === "home" ? resumableGame(SAVE_KEY) : null;
    return saved ? summarizeSavedGame(saved) : null;
  }, [route]);
  const botGame = useMemo(() => {
    const saved = route.kind === "home" ? resumableGame(BOT_SAVE_KEY) : null;
    return saved ? summarizeSavedGame(saved) : null;
  }, [route]);

  // Warm the 3D chunk once the first screen has painted, so starting a game is (usually) instant.
  useEffect(() => {
    const warm = () => void loadScene().catch(() => {});
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 2500 });
      return () => cancelIdleCallback(id);
    }
    const id = setTimeout(warm, 600);
    return () => clearTimeout(id);
  }, []);

  const goHome = useCallback(() => router.back(HOME), []);
  const saveName = useCallback((next: string) => setName(setPlayerName(next) ?? next), []);

  // Leaving a room for home must not leave the room behind the Back button as "forward only":
  // from a game, "home" is a fresh navigation the player can come back from.
  const leaveRoom = useCallback(() => router.push(HOME), []);

  const onlineGame = useCallback(
    (game: OnlineGame) => (
      <OnlineGameView key={`${game.session.code}:${game.gameNumber}`} game={game} onHome={leaveRoom} />
    ),
    [leaveRoom],
  );

  let screen;
  switch (route.kind) {
    case "home":
      screen = editingName ? (
        <NameScreen
          initial={name ?? ""}
          submitLabel="Save name"
          onBack={() => setEditingName(false)}
          onDone={(next) => {
            saveName(next);
            setEditingName(false);
          }}
        />
      ) : (
        <HomeScreen
          deviceId={deviceId}
          name={name}
          localGame={localGame}
          botGame={botGame}
          onLocal={() => router.push({ kind: "local" })}
          onBots={() => router.push({ kind: "bots" })}
          onHost={() => router.push({ kind: "room", code: newRoomCode(), host: true })}
          onJoin={() => router.push({ kind: "join" })}
          onOpenRoom={(code) => router.push({ kind: "room", code, host: false })}
          onEditName={() => setEditingName(true)}
        />
      );
      break;
    case "local":
    case "bots":
      // Keyed so switching between the two never carries one's game into the other.
      screen = <LocalPlay key={route.kind} mode={route.kind} name={name} onHome={goHome} />;
      break;
    case "join":
      // Replace, so Back from the room goes home rather than to a stale form.
      screen = <JoinScreen onBack={goHome} onJoin={(code) => router.replace({ kind: "room", code, host: false })} />;
      break;
    case "room":
      screen =
        name === null ? (
          <NameScreen key={route.code} onBack={goHome} onDone={saveName} submitLabel={route.host ? "Create game" : "Join game"} />
        ) : (
          <RoomScreen
            key={route.code}
            code={route.code}
            host={route.host}
            deviceId={deviceId}
            name={name}
            onHome={goHome}
            onJoinAnother={() => router.replace({ kind: "join" })}
            renderGame={onlineGame}
          />
        );
      break;
  }

  return (
    <>
      {screen}
      <MuteButton />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// On this device (pass-and-play, or against bots): setup screen, then the game (saved in
// localStorage as it goes, each mode in its own slot)
// ---------------------------------------------------------------------------------------------

/**
 * The saved local game, if it is worth offering back: unfinished (persistence only keeps those)
 * and with at least one move. A game nobody has rolled in yet is just its settings, and offering
 * to "resume" it after the player chose New game reads as if their game hadn't ended.
 */
function resumableGame(key: string): SavedGame | null {
  const saved = loadSavedGame(undefined, key);
  if (saved && saved.log.length === 0) {
    clearSavedGame(undefined, key);
    return null;
  }
  return saved;
}

type LocalScreen =
  | { kind: "setup" }
  | { kind: "playing"; input: GameInput; session: GameSession; presenter: Presenter; gameId: number };

let nextGameId = 1;

interface LocalPlayProps {
  mode: "local" | "bots";
  /** The online name, if any: the default name for the person's seat against bots. */
  name: string | null;
  onHome: () => void;
}

function LocalPlay({ mode, name, onHome }: LocalPlayProps) {
  const saveKey = mode === "bots" ? BOT_SAVE_KEY : SAVE_KEY;
  const [screen, setScreen] = useState<LocalScreen>({ kind: "setup" });
  const [saved, setSaved] = useState<SavedGame | null>(() => resumableGame(saveKey));

  // Session + presenter are created in event handlers (never during render, so StrictMode can't
  // double them) and the previous game's presenter is stopped when the screen changes.
  const current = useRef(screen);
  const show = useCallback((next: LocalScreen) => {
    const previous = current.current;
    if (previous.kind === "playing" && previous !== next) previous.presenter.stop();
    current.current = next;
    setScreen(next);
  }, []);

  // Leaving local play (Back, Home) stops whatever was running. Deferred a tick: StrictMode's
  // rehearsal unmount is followed at once by a remount, which must keep the game going.
  useEffect(() => {
    let unmounted = false;
    return () => {
      unmounted = true;
      queueMicrotask(() => {
        if (unmounted && current.current.kind === "playing") current.current.presenter.stop();
      });
    };
  }, []);

  const open = useCallback(
    (input: GameInput, from?: SavedGame) => {
      const session = createLocalSession({ input, log: from?.log ?? [] });
      show({ kind: "playing", input, session, presenter: new Presenter(session), gameId: nextGameId++ });
    },
    [show],
  );

  const start = useCallback(
    (input: GameInput) => {
      clearSavedGame(undefined, saveKey);
      setSaved(null);
      open(input);
    },
    [open, saveKey],
  );

  const resume = useCallback(() => {
    const game = resumableGame(saveKey);
    if (!game) {
      clearSavedGame(undefined, saveKey);
      setSaved(null);
      return;
    }
    open(game.input, game);
  }, [open, saveKey]);

  const newGame = useCallback(() => {
    // A game that is still running was saved on its last change; offer it back on the setup
    // screen. One that is over (New game from the game-over screen) is never offered, even if a
    // stale save of it is somehow still around.
    const previous = current.current;
    if (previous.kind === "playing") {
      const { input, log } = previous.session.getState();
      if (replayLog(input, log).status !== "active") clearSavedGame(undefined, saveKey);
    }
    setSaved(resumableGame(saveKey));
    show({ kind: "setup" });
  }, [show, saveKey]);

  const currentInput = screen.kind === "playing" ? screen.input : null;
  const actions = useMemo<AppActions>(
    () => ({ newGame, playAgain: () => (currentInput ? start(currentInput) : newGame()) }),
    [currentInput, newGame, start],
  );
  const savedSummary = useMemo(() => (saved ? summarizeSavedGame(saved) : null), [saved]);

  if (screen.kind === "setup") {
    return (
      <SetupScreen
        mode={mode}
        onlineName={name}
        onStart={start}
        savedGame={savedSummary}
        onResume={resume}
        onBack={onHome}
      />
    );
  }
  return (
    <GameView
      key={screen.gameId}
      session={screen.session}
      presenter={screen.presenter}
      actions={actions}
      saveKey={saveKey}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// The table: shared by local and online games
// ---------------------------------------------------------------------------------------------

function OnlineGameView({ game, onHome }: { game: OnlineGame; onHome: () => void }) {
  const { session, presenter } = game;
  const actions = useMemo<AppActions>(() => ({ playAgain: session.rematch, newGame: onHome }), [session, onHome]);
  return <GameView session={session} presenter={presenter} actions={actions} />;
}

interface GameViewProps {
  session: GameSession;
  presenter: Presenter;
  actions: AppActions;
  /** Local games: where the game is saved as it goes. */
  saveKey?: string;
}

function GameView({ session, presenter, actions, saveKey = SAVE_KEY }: GameViewProps) {
  const sceneReady = useSceneReady();
  // Mirror a local game into localStorage for as long as this view is mounted.
  useEffect(
    () => (session.kind === "local" ? persistSession(session, undefined, saveKey) : undefined),
    [session, saveKey],
  );
  // Bots play their seats (if the game has any) at the pace of what is on screen.
  useEffect(() => (session.kind === "local" ? driveBots(session, presenter) : undefined), [session, presenter]);

  return (
    <AppActionsContext.Provider value={actions}>
      <GameProvider session={session} presenter={presenter}>
        <div className="app-game">
          <Suspense fallback={<LoadingScreen />}>
            <GameCanvas />
            <Hud onNewGame={actions.newGame} />
            {sceneReady ? <div className="app-curtain" aria-hidden="true" /> : <LoadingScreen />}
          </Suspense>
        </div>
      </GameProvider>
    </AppActionsContext.Provider>
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
