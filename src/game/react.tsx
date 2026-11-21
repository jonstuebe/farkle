import { createActorContext } from "@xstate/react";
import { farkleMachine } from "./machine";

/**
 * The one game actor shared by the 3D scene and the HUD.
 * R3F v9 bridges React context into <Canvas>, so scene components can use these hooks too.
 */
export const FarkleContext = createActorContext(farkleMachine);

/** Read derived game state; re-renders only when the selected value changes. */
export const useGameSelector = FarkleContext.useSelector;

/** The game actor, for sending events: `useGameActor().send({ type: "roll" })`. */
export const useGameActor = FarkleContext.useActorRef;
