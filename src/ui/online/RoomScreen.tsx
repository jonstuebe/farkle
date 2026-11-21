import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Presenter } from "../../game/presenter";
import { createOnlineSession, type OnlineSession, type RoomError } from "../../net/onlineSession";
import { forgetRoom, rememberRoom } from "../../net/savedRooms";
import { Screen } from "../setup/Brand";
import { Lobby, spacedCode } from "./Lobby";
import "./online.css";

export interface OnlineGame {
  session: OnlineSession;
  presenter: Presenter;
  gameNumber: number;
}

interface RoomScreenProps {
  code: string;
  /** This device is creating the room. */
  host: boolean;
  deviceId: string;
  name: string;
  onHome: () => void;
  onJoinAnother: () => void;
  /** Renders the 3D table and HUD for a game in progress. */
  renderGame: (game: OnlineGame) => ReactNode;
}

const ERRORS: Record<RoomError, { title: string; body: string }> = {
  missing: {
    title: "Game not found",
    body: "There's no game with this code. It may have been cancelled or expired, or the code has a typo.",
  },
  full: { title: "This game is full", body: "All eight seats are taken. Ask your friend to start another game." },
  started: {
    title: "This game already started",
    body: "It began before you joined, so there's no seat for this device. If you were playing on another phone or browser, open it there.",
  },
  expired: { title: "This game has expired", body: "Nobody played for a while, so it was put away." },
  cancelled: { title: "The invite was cancelled", body: "This game was called off before it started." },
};

/** Opens the connection for as long as the screen is mounted. Null for the first render. */
function useOnlineSession(code: string, host: boolean, deviceId: string, name: string): OnlineSession | null {
  const [session, setSession] = useState<OnlineSession | null>(null);
  useEffect(() => {
    // Created here, not during render: StrictMode's second mount gets its own session, and the
    // first one is closed before its (deferred) socket is ever opened.
    const created = createOnlineSession({ code, deviceId, name, intent: host ? "host" : "join" });
    created.open();
    setSession(created);
    return () => {
      created.close();
      setSession(null);
    };
  }, [code, host, deviceId, name]);
  return session;
}

const noSubscription = () => () => {};

/** `/r/CODE`: connects to the room and shows its lobby, its game, or why it can't be opened. */
export function RoomScreen({ code, host, deviceId, name, onHome, onJoinAnother, renderGame }: RoomScreenProps) {
  const session = useOnlineSession(code, host, deviceId, name);
  const state = useSyncExternalStore(session?.subscribe ?? noSubscription, () => session?.getRoom() ?? null);
  const gameNumber = useSyncExternalStore(session?.subscribe ?? noSubscription, () => session?.getState().gameNumber ?? 0);
  const phase = state?.room?.phase ?? null;
  const seated = state?.seat != null;
  const error = state?.error ?? null;

  // Keep "your online games" in step: seated rooms are remembered, dead ones forgotten.
  useEffect(() => {
    if (seated) rememberRoom(code);
  }, [seated, code]);
  useEffect(() => {
    if (error) forgetRoom(code);
  }, [error, code]);

  useEffect(() => {
    document.title = `Farkle · ${code}`;
    return () => {
      document.title = "Farkle";
    };
  }, [code]);

  // One Presenter per game number (a rematch is a new game with a new log).
  const [game, setGame] = useState<OnlineGame | null>(null);
  useEffect(() => {
    if (!session || phase !== "playing" || gameNumber === 0) return;
    const presenter = new Presenter(session);
    setGame({ session, presenter, gameNumber });
    return () => {
      presenter.stop();
      setGame(null);
    };
  }, [session, phase, gameNumber]);

  if (error) {
    const message = ERRORS[error];
    return (
      <Screen onBack={onHome} compact>
        <section className="setup__card online__notice" role="alert">
          <h2 className="setup__heading">{message.title}</h2>
          <p className="online__code online__code--small" aria-label={`Game code ${code.split("").join(" ")}`}>
            <span aria-hidden="true">{spacedCode(code)}</span>
          </p>
          <p className="online__lead">{message.body}</p>
          <button type="button" className="setup__btn setup__btn--primary" onClick={onHome}>
            Back to home
          </button>
          {error === "missing" ? (
            <button type="button" className="setup__btn setup__btn--ghost" onClick={onJoinAnother}>
              Try another code
            </button>
          ) : null}
        </section>
      </Screen>
    );
  }

  const room = state?.room ?? null;
  if (!session || !state || !room || state.seat === null) {
    return (
      <Screen onBack={onHome} compact>
        <section className="setup__card online__notice" role="status" aria-live="polite">
          <h2 className="setup__heading">{host ? "Setting up your game…" : "Finding the game…"}</h2>
          <p className="online__code online__code--small" aria-hidden="true">
            {spacedCode(code)}
          </p>
          <div className="app-loading__bar" aria-hidden="true" />
          <p className="online__lead">Connecting. If this takes a while, check your internet connection.</p>
        </section>
      </Screen>
    );
  }

  if (room.phase === "lobby") {
    return (
      <Lobby
        room={room}
        mySeat={state.seat}
        connected={state.status === "open"}
        onConfigure={session.configure}
        onStart={session.start}
        onCancel={async () => {
          const ok = await session.cancel();
          // The host doesn't need to be told what they just did: straight back home.
          if (ok) {
            forgetRoom(code);
            onHome();
          }
          return ok;
        }}
        onBack={onHome}
        onLeave={() => {
          // There is no "give up my seat" message in the protocol: leaving takes the game off
          // this device's list, and the seat stays (the invite link brings the player back).
          session.close();
          forgetRoom(code);
          onHome();
        }}
      />
    );
  }

  // The Presenter for this game number is made in an effect, one render after the room arrives.
  if (!game || game.session !== session || game.gameNumber !== gameNumber) return <div className="app-game" />;
  return renderGame(game);
}
