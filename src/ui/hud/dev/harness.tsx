/**
 * Dev-only harness: mounts the real game view (scene + HUD) on a scripted, fake *online*
 * session, so the online HUD can be looked at without a server. Not part of the production
 * build (nothing imports it); open it through the Vite dev server:
 *
 *   /src/ui/hud/dev/harness.html?scene=replay        missed moves, replayed from the start
 *   /src/ui/hud/dev/harness.html?scene=watch         another player's turn, live
 *   /src/ui/hud/dev/harness.html?scene=mine          my turn
 *   /src/ui/hud/dev/harness.html?scene=over          finished game
 *   /src/ui/hud/dev/harness.html?scene=keeps         my turn, a 5 kept from each of two rolls, a third 5 up
 *   /src/ui/hud/dev/harness.html?scene=crowd         eight players, my turn (seat 6)
 *   &local=1       a local session instead (no reactions)
 *   &connected=0   start disconnected        &away=0,1   seats shown as away
 *   &canvas=0      no 3D scene: throws settle on a timer instead
 *
 * `window.__fake` drives it afterwards: act(intent, dice?), setConnected(bool), setPresence([...]),
 * react(seat, reaction) (as if another player reacted), sent (reactions this device sent).
 */
import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import type { GameInput } from "../../../game/machine";
import { applyIntent, replayLog, type Intent, type LogEntry } from "../../../game/log";
import { Presenter } from "../../../game/presenter";
import { AppActionsContext, GameProvider, usePendingThrow, useThrowSettled } from "../../../game/react";
import type { DieValue } from "../../../game/scoring";
import type { GameSession, SessionState } from "../../../game/session";
import type { Reaction } from "../../../net/protocol";
import { MuteButton } from "../../../audio/MuteButton";
import { Hud } from "../Hud";
import "../../../index.css";

const GameCanvas = lazy(() => import("../../../scene/GameCanvas").then((m) => ({ default: m.GameCanvas })));

type Step = [intent: Intent, dice?: DieValue[]];

/** Runs scripted moves through the real `applyIntent`, with the dice fixed by the script. */
function playScript(input: GameInput, steps: readonly Step[], log: readonly LogEntry[] = []): LogEntry[] {
  const out = [...log];
  for (const [intent, dice = []] of steps) {
    const snapshot = replayLog(input, out);
    const queue = [...dice];
    const result = applyIntent(snapshot, out.length, snapshot.context.current, intent, () => queue.shift() ?? 2);
    if (!result.ok) throw new Error(`Scripted ${intent.type} rejected: ${result.reason}`);
    out.push(...result.entries);
  }
  return out;
}

const pick = (...indices: number[]): Step[] => indices.map((index) => [{ type: "toggleDie", index }]);

// Seats: Ada (0), Bo (1), me (2).
const ADA_FARKLES: Step[] = [
  [{ type: "roll" }, [1, 5, 2, 3, 4, 4]],
  ...pick(0, 1),
  [{ type: "keepAndRoll" }, [2, 3, 4, 6]],
  [{ type: "passTurn" }],
];
const BO_BANKS_1000: Step[] = [[{ type: "roll" }, [1, 1, 1, 2, 3, 4]], ...pick(0, 1, 2), [{ type: "bank" }]];
const ME_BANK_300: Step[] = [[{ type: "roll" }, [3, 3, 3, 2, 4, 6]], ...pick(0, 1, 2), [{ type: "bank" }]];

interface Scene {
  input: GameInput;
  log: LogEntry[];
  seenFrom: number;
  mySeat?: number;
}

function buildScene(name: string): Scene {
  const players = ["Ada", "Bo", "Jon"];
  switch (name) {
    case "watch": {
      const input: GameInput = { players };
      const log = playScript(input, [[{ type: "roll" }, [1, 5, 2, 3, 4, 4]], ...pick(0)]);
      return { input, log, seenFrom: log.length };
    }
    case "mine": {
      const input: GameInput = { players };
      const log = playScript(input, [...ADA_FARKLES, ...BO_BANKS_1000]);
      return { input, log, seenFrom: log.length };
    }
    case "over": {
      const input: GameInput = { players, rules: { targetScore: 1000 } };
      const log = playScript(input, [
        ...ADA_FARKLES,
        ...BO_BANKS_1000,
        ...ME_BANK_300,
        [{ type: "roll" }, [2, 3, 4, 6, 6, 2]],
        [{ type: "passTurn" }],
      ]);
      return { input, log, seenFrom: log.length };
    }
    case "keeps": {
      const input: GameInput = { players };
      const log = playScript(input, [
        ...ADA_FARKLES,
        ...BO_BANKS_1000,
        [{ type: "roll" }, [5, 2, 3, 4, 6, 6]],
        ...pick(0),
        [{ type: "keepAndRoll" }, [5, 2, 3, 4, 6]],
        ...pick(1),
        [{ type: "keepAndRoll" }, [5, 2, 3, 4]],
      ]);
      return { input, log, seenFrom: log.length };
    }
    case "crowd": {
      const input: GameInput = { players: ["Ada", "Bo", "Cyrus", "Dee", "Eliza", "Finn", "Jon", "Hana"] };
      const steps: Step[] = [];
      for (let seat = 0; seat < 6; seat++) steps.push(...(seat % 2 ? BO_BANKS_1000 : ME_BANK_300));
      const log = playScript(input, steps);
      return { input, log, seenFrom: log.length, mySeat: 6 };
    }
    default: {
      const input: GameInput = { players };
      const log = playScript(input, [...ADA_FARKLES, ...BO_BANKS_1000]);
      return { input, log, seenFrom: 0 };
    }
  }
}

interface FakeSession extends GameSession {
  act(intent: Intent, dice?: DieValue[]): void;
  setConnected(connected: boolean): void;
  setPresence(presence: boolean[]): void;
  react(seat: number, reaction: Reaction): void;
  sent: Reaction[];
}

function createFakeOnlineSession(scene: Scene, connected: boolean, presence: boolean[], local: boolean): FakeSession {
  const listeners = new Set<() => void>();
  const reactionListeners = new Set<(seat: number, reaction: Reaction) => void>();
  const sent: Reaction[] = [];
  let state: SessionState = {
    gameNumber: 1,
    input: scene.input,
    log: scene.log,
    mySeats: local ? scene.input.players.map((_, i) => i) : [scene.mySeat ?? 2],
    seenFrom: scene.seenFrom,
    connected,
    presence: local ? null : presence,
  };
  const commit = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  /** Any seat's move, as the server would broadcast it. */
  const act = (intent: Intent, dice?: DieValue[]) => commit({ log: playScript(state.input, [[intent, dice]], state.log) });
  return {
    kind: local ? "local" : "online",
    ...(local
      ? {}
      : {
          reactions: {
            send: (reaction: Reaction) => void sent.push(reaction),
            subscribe(listener: (seat: number, reaction: Reaction) => void) {
              reactionListeners.add(listener);
              return () => reactionListeners.delete(listener);
            },
          },
        }),
    react: (seat, reaction) => reactionListeners.forEach((listener) => listener(seat, reaction)),
    sent,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sendIntent(intent) {
      const snapshot = replayLog(state.input, state.log);
      if (!state.connected || !state.mySeats.includes(snapshot.context.current)) return;
      // Remember the dice so a test can script them: __fake.nextDice = [5, 5, 5, ...]
      const queue = [...(window.__fake?.nextDice ?? [])];
      const result = applyIntent(
        snapshot,
        state.log.length,
        snapshot.context.current,
        intent,
        queue.length ? () => queue.shift() ?? 2 : undefined,
      );
      if (window.__fake) window.__fake.nextDice = undefined;
      if (result.ok) commit({ log: [...state.log, ...result.entries] });
    },
    markSeen() {},
    act,
    setConnected: (value) => commit({ connected: value }),
    setPresence: (value) => commit({ presence: value }),
  };
}

/** Stands in for the scene when it is switched off: "lands" every throw after a moment. */
function AutoSettle() {
  const pending = usePendingThrow();
  const settled = useThrowSettled();
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => settled(pending.seq), 700);
    return () => clearTimeout(timer);
  }, [pending, settled]);
  return null;
}

declare global {
  interface Window {
    __fake?: FakeSession & { presenter: Presenter; log: string[]; nextDice?: DieValue[] };
  }
}

const params = new URLSearchParams(location.search);
const away = (params.get("away") ?? "").split(",").filter(Boolean).map(Number);
const scene = buildScene(params.get("scene") ?? "replay");
const session = createFakeOnlineSession(
  scene,
  params.get("connected") !== "0",
  scene.input.players.map((_, seat) => !away.includes(seat)),
  params.get("local") === "1",
);
const presenter = new Presenter(session);
const actionLog: string[] = [];
window.__fake = Object.assign(session, { presenter, log: actionLog });
const withCanvas = params.get("canvas") !== "0";
const appActions = {
  playAgain: () => actionLog.push("playAgain"),
  newGame: () => actionLog.push("newGame"),
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppActionsContext.Provider value={appActions}>
      <GameProvider session={session} presenter={presenter}>
        <div className="app-game">
          <Suspense fallback={null}>
            {withCanvas ? <GameCanvas /> : <AutoSettle />}
            <Hud onNewGame={appActions.newGame} />
          </Suspense>
        </div>
      </GameProvider>
    </AppActionsContext.Provider>
    <MuteButton />
  </StrictMode>,
);
