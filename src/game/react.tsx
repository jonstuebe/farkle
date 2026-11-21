/**
 * React bindings for the game. Everything UI code needs from the game lives here.
 *
 * Inside <GameProvider> (also inside the R3F <Canvas>, which bridges context):
 *
 *   Reading the presented game (what the player is watching, which may lag the authoritative log
 *   during throw animations and replays):
 *     const score = useGameSelector((snapshot) => snapshot.context.players[0]?.score);
 *     const actor = useGameActor();   // the presented actor, for subscribe()/getSnapshot() only
 *
 *   Acting (never send events to the actor directly; it is fed by the Presenter):
 *     const sendIntent = useGameIntent();   sendIntent({ type: "roll" })
 *     const canAct = useCanAct();           // my seat's turn, connected, nothing playing out
 *
 *   Throw hand-off (scene): usePendingThrow() gives { seq, indices, values } while a throw must
 *   be animated; land each die in `indices` on its `values` entry, then call
 *   useThrowSettled()(seq). If useSnapCount() changes, seat the dice from context immediately.
 *
 *   Replay (HUD): const { replaying, fed, total, skip } = useReplay();
 *   Seats: useMySeats() -> seats this device plays (all of them locally).
 *   Session: useGameSession() -> { kind: "local" | "online", connected, gameNumber }.
 *
 * App-level actions (restart / leave the game), for the HUD and the game-over screen:
 *   const { playAgain, newGame } = useAppActions();
 *     playAgain()  local: start a fresh game with the same players and rules.
 *                  online: ask the room for a rematch.
 *     newGame()    leave to the home/setup screen.
 *   Both are stable callbacks, safe to call from event handlers at any time. Outside of
 *   `<App>` (tests, stories) they are no-ops.
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { createActorContext } from "@xstate/react";
import { farkleMachine } from "./machine";
import type { Intent } from "./log";
import type { Presenter, PresenterView } from "./presenter";
import type { GameSession, SessionState } from "./session";

/** The presented game actor. Provided by <GameProvider>; don't send events to it. */
export const FarkleContext = createActorContext(farkleMachine);

/** Read derived presented-game state; re-renders only when the selected value changes. */
export const useGameSelector = FarkleContext.useSelector;

/** The presented game actor (subscribe / getSnapshot). Act with useGameIntent instead of send. */
export const useGameActor = FarkleContext.useActorRef;

interface GameRuntime {
  session: GameSession;
  presenter: Presenter;
}

const GameRuntimeContext = createContext<GameRuntime | null>(null);

function useRuntime(): GameRuntime {
  const runtime = useContext(GameRuntimeContext);
  if (!runtime) throw new Error("Game hooks must be used inside <GameProvider>");
  return runtime;
}

/** Provides one game (session + presenter). Remount (change `key`) for a new game number. */
export function GameProvider({ session, presenter, children }: GameRuntime & { children: ReactNode }) {
  const runtime = useMemo(() => ({ session, presenter }), [session, presenter]);
  return (
    <GameRuntimeContext.Provider value={runtime}>
      <FarkleContext.Provider actor={presenter.actor}>{children}</FarkleContext.Provider>
    </GameRuntimeContext.Provider>
  );
}

function usePresenterView<T>(select: (view: PresenterView) => T): T {
  const { presenter } = useRuntime();
  return useSyncExternalStore(presenter.subscribe, () => select(presenter.getView()));
}

function useSessionState<T>(select: (state: SessionState) => T): T {
  const { session } = useRuntime();
  return useSyncExternalStore(session.subscribe, () => select(session.getState()));
}

/** Send a move for the current player. Ignored by the session if it isn't allowed. */
export function useGameIntent(): (intent: Intent) => void {
  const { session } = useRuntime();
  return useCallback((intent: Intent) => session.sendIntent(intent), [session]);
}

/** True when this device may act right now (its seat's turn and nothing still playing out). */
export function useCanAct(): boolean {
  const { presenter } = useRuntime();
  // Re-evaluate on presenter, session and presented-actor changes.
  usePresenterView((v) => v);
  useSessionState((s) => s);
  useGameSelector((s) => s);
  return presenter.canAct();
}

export const usePendingThrow = () => usePresenterView((v) => v.pendingThrow);
export const useSnapCount = () => usePresenterView((v) => v.snapCount);

export function useThrowSettled(): (seq: number) => void {
  return useRuntime().presenter.throwSettled;
}

export function useReplay() {
  const { presenter } = useRuntime();
  const replaying = usePresenterView((v) => v.replaying);
  const fed = usePresenterView((v) => v.fed);
  const total = usePresenterView((v) => v.total);
  return { replaying, fed, total, skip: presenter.skip };
}

export const useMySeats = () => useSessionState((s) => s.mySeats);

export function useGameSession() {
  const kind = useRuntime().session.kind;
  const connected = useSessionState((s) => s.connected);
  const gameNumber = useSessionState((s) => s.gameNumber);
  return { kind, connected, gameNumber };
}

export interface AppActions {
  /** Local: new game with the same players and rules. Online: request a rematch. */
  playAgain: () => void;
  /** Go back to the home/setup screen. */
  newGame: () => void;
}

const NO_APP_ACTIONS: AppActions = { playAgain: () => {}, newGame: () => {} };

/** Provided by `<App>` around the game view. */
export const AppActionsContext = createContext<AppActions>(NO_APP_ACTIONS);

/** Restart or leave the current game. See the notes at the top of this file. */
export const useAppActions = (): AppActions => useContext(AppActionsContext);
