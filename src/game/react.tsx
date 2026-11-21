/**
 * React bindings for the game. Everything UI code needs from the game lives here.
 *
 * Game state (inside `<FarkleContext.Provider>`, including inside the R3F `<Canvas>`):
 *   const score = useGameSelector((snapshot) => snapshot.context.players[0]?.score);
 *   const actor = useGameActor();   actor.send({ type: "roll" });
 *
 * App-level actions (restart / leave the game), for the HUD and the game-over screen:
 *   const { playAgain, newGame } = useAppActions();
 *     playAgain()  start a fresh game right away with the same players and rules
 *                  (scores reset, saved game replaced). Use for "Play again" / "Rematch".
 *     newGame()    leave to the setup screen to change players or rules. Same thing as the
 *                  `onNewGame` prop of `<Hud>`. A game still in progress stays saved and is
 *                  offered there as "Resume game"; a finished one is not.
 *   Both are stable callbacks, safe to call from event handlers at any time. Outside of
 *   `<App>` (tests, stories) they are no-ops.
 *
 * Save/resume is automatic (see `./persistence.ts`); UI code does not need to do anything.
 * One consequence for the scene: a game can start in any settled state (`awaitingRoll`,
 * `choosing`, `farkled`) with dice values and held flags already in context, never in `rolling`.
 */
import { createContext, useContext } from "react";
import { createActorContext } from "@xstate/react";
import { farkleMachine } from "./machine";

/**
 * The one game actor shared by the 3D scene and the HUD.
 * R3F v9 bridges React context into <Canvas>, so scene components can use these hooks too.
 * The provider takes `actor` (a new or restored actor, created once by `<App>`).
 */
export const FarkleContext = createActorContext(farkleMachine);

/** Read derived game state; re-renders only when the selected value changes. */
export const useGameSelector = FarkleContext.useSelector;

/** The game actor, for sending events: `useGameActor().send({ type: "roll" })`. */
export const useGameActor = FarkleContext.useActorRef;

export interface AppActions {
  /** Start a new game immediately with the same players and rules. */
  playAgain: () => void;
  /** Go back to the setup screen. */
  newGame: () => void;
}

const NO_APP_ACTIONS: AppActions = { playAgain: () => {}, newGame: () => {} };

/** Provided by `<App>` around the game view. */
export const AppActionsContext = createContext<AppActions>(NO_APP_ACTIONS);

/** Restart or leave the current game. See the notes at the top of this file. */
export const useAppActions = (): AppActions => useContext(AppActionsContext);
