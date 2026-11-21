import { useEffect, useState } from "react";
import { useAppActions, useGameActor, useGameSelector } from "../../game/react";
import { winners } from "../../game/machine";
import { Banners, useBanners } from "./Banners";
import { Dock } from "./Dock";
import { GameOver } from "./GameOver";
import { RulesPanel } from "./RulesPanel";
import { Scoreboard } from "./Scoreboard";
import { viewOf } from "./logic";
import "./hud.css";

declare global {
  interface Window {
    /** Dev builds only. */
    __farkleHud?: { actor: ReturnType<typeof useGameActor> };
  }
}

export interface HudProps {
  /** Leave the current game and go back to the setup screen. */
  onNewGame: () => void;
}

/** In-game overlay: scoreboard, turn info, action buttons, banners, game over. */
export function Hud({ onNewGame }: HudProps) {
  const actor = useGameActor();
  const snapshot = useGameSelector((s) => s);
  const view = viewOf(snapshot);
  const { playAgain } = useAppActions();
  const banners = useBanners(actor);
  const [rulesOpen, setRulesOpen] = useState(false);

  // Dev-only handle for driving the game from the console or a headless browser:
  //   __farkleHud.actor.send({ type: "rolled", values: [1, 5, 2, 3, 4, 6] })
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const handle = { actor };
    window.__farkleHud = handle;
    return () => {
      if (window.__farkleHud === handle) delete window.__farkleHud;
    };
  }, [actor]);

  const done = view.phase === "done";
  const { context } = view;

  return (
    <div className="fk-hud">
      <div className="fk-top">
        <Scoreboard context={context} done={done} rulesOpen={rulesOpen} onToggleRules={() => setRulesOpen((o) => !o)} />
      </div>
      <Banners banners={banners} />
      {!done && <Dock view={view} send={actor.send} shortcutsEnabled={!rulesOpen} />}
      {rulesOpen && <RulesPanel rules={context.rules} onClose={() => setRulesOpen(false)} />}
      {done && (
        <GameOver
          players={snapshot.output?.players ?? context.players}
          winners={snapshot.output?.winners ?? winners(context.players)}
          onPlayAgain={playAgain}
          onNewGame={onNewGame}
        />
      )}
    </div>
  );
}
