import { useEffect, useMemo, useState } from "react";
import {
  useAppActions,
  useCanAct,
  useGameActor,
  useGameIntent,
  useGameSelector,
  useGameSession,
  useMySeats,
  useReplay,
  useSeatPresence,
  useSnapCount,
} from "../../game/react";
import { winners } from "../../game/machine";
import { Banners, useBanners } from "./Banners";
import { Dock } from "./Dock";
import { GameOver } from "./GameOver";
import { RulesPanel } from "./RulesPanel";
import { ReactionButton, ReactionFloats, useReactionFloats } from "./Reactions";
import { Scoreboard } from "./Scoreboard";
import { viewOf, type Table } from "./logic";
import "./hud.css";

declare global {
  interface Window {
    /** Dev builds only. */
    __farkleHud?: { actor: ReturnType<typeof useGameActor>; sendIntent: ReturnType<typeof useGameIntent> };
  }
}

export interface HudProps {
  /** Leave the current game: the setup screen locally, the list of games online. */
  onNewGame: () => void;
}

/**
 * In-game overlay: scoreboard, turn info, action buttons, banners, game over.
 *
 * It shows the *presented* game, which online can be a replay of moves this device missed or
 * another player's turn; `table` says which seats are this device's, and from that the pieces
 * decide between acting, watching and catching up. In a local game every seat is "mine".
 */
export function Hud({ onNewGame }: HudProps) {
  const actor = useGameActor();
  const sendIntent = useGameIntent();
  const canAct = useCanAct();
  const snapshot = useGameSelector((s) => s);
  const view = viewOf(snapshot);
  const { playAgain } = useAppActions();
  const session = useGameSession();
  const mySeats = useMySeats();
  const presence = useSeatPresence();
  const replay = useReplay();
  const snapCount = useSnapCount();
  const [rulesOpen, setRulesOpen] = useState(false);

  const online = session.kind === "online";
  const table = useMemo<Table>(() => ({ online, mySeats }), [online, mySeats]);
  const names = useMemo(() => view.context.players.map((p) => p.name), [view.context.players]);
  const reactions = useReactionFloats(online ? (mySeats[0] ?? null) : null, names);
  const banners = useBanners(actor, { table, replaying: replay.replaying, snapCount });

  // Dev-only handle for driving the game from the console or a headless browser:
  //   __farkleHud.sendIntent({ type: "toggleDie", index: 0 })   (actor is read-only: the presented game)
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handle = { actor, sendIntent };
    window.__farkleHud = handle;
    return () => {
      if (window.__farkleHud === handle) delete window.__farkleHud;
    };
  }, [actor, sendIntent]);

  const { context } = view;
  // The game-over screen waits for the replay that leads up to it.
  const done = view.phase === "done";
  const reconnecting = online && !session.connected;
  const currentAway = online && presence !== null && presence[context.current] !== true;

  return (
    <div className="fk-hud">
      <div className="fk-top">
        <Scoreboard
          context={context}
          done={done}
          table={table}
          presence={online ? presence : null}
          rulesOpen={rulesOpen}
          onToggleRules={() => setRulesOpen((o) => !o)}
          tools={reactions.send && <ReactionButton send={reactions.send} cooling={reactions.coolUntil > 0} />}
        />
      </div>
      <Banners banners={banners} reconnecting={reconnecting} />
      <ReactionFloats floats={reactions.floats} />
      {!done && (
        <Dock
          view={view}
          send={sendIntent}
          table={table}
          canAct={canAct}
          connected={!reconnecting}
          currentAway={currentAway}
          replay={replay}
          shortcutsEnabled={!rulesOpen}
        />
      )}
      {rulesOpen && <RulesPanel rules={context.rules} onClose={() => setRulesOpen(false)} />}
      {done && (
        <GameOver
          players={snapshot.output?.players ?? context.players}
          winners={snapshot.output?.winners ?? winners(context.players)}
          table={table}
          connected={!reconnecting}
          onPlayAgain={playAgain}
          onNewGame={onNewGame}
        />
      )}
    </div>
  );
}
