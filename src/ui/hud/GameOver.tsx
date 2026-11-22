import { useEffect, useRef, useState } from "react";
import type { Player } from "../../game/machine";
import { formatPoints, gameOverLabels, isBot, isYou, onlineWinnerHeadline, rankPlayers, type Table } from "./logic";

export interface GameOverProps {
  players: readonly Player[];
  winners: readonly number[];
  table: Table;
  /** Online only: false while the socket is reconnecting (a rematch can't be asked for). */
  connected: boolean;
  /** Local: same players and rules, fresh scores. Online: ask the room for a rematch. */
  onPlayAgain: () => void;
  /** Local: back to the setup screen. Online: back to the list of games. */
  onNewGame: () => void;
}

export function GameOver({ players, winners, table, connected, onPlayAgain, onNewGame }: GameOverProps) {
  const labels = gameOverLabels(table.online);
  // Online, the rematch arrives from the room as a new game (which remounts the HUD), so the
  // button waits instead of inviting a second tap.
  const [asked, setAsked] = useState(false);
  const waiting = table.online && asked;
  const canAsk = !waiting && (!table.online || connected);
  const again = () => {
    if (!canAsk) return;
    if (table.online) setAsked(true);
    onPlayAgain();
  };
  const dialogRef = useRef<HTMLDivElement>(null);
  const againRef = useRef<HTMLButtonElement>(null);
  const ranked = rankPlayers(players);
  const tie = winners.length > 1;

  useEffect(() => {
    againRef.current?.focus();
  }, []);

  // Keep Tab inside the dialog; the game behind it is finished.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const buttons = dialogRef.current?.querySelectorAll<HTMLElement>("button");
    if (!buttons || buttons.length === 0) return;
    const first = buttons[0]!;
    const last = buttons[buttons.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fk-scrim">
      <div
        ref={dialogRef}
        className="fk-panel fk-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="fk-gameover-title"
        onKeyDown={onKeyDown}
      >
        <p className="fk-modal__eyebrow">{tie ? "It's a tie" : "Game over"}</p>
        <h2 id="fk-gameover-title" className="fk-modal__title">
          {onlineWinnerHeadline(players, winners, table)}
        </h2>
        <ol className="fk-ranking">
          {ranked.map((player) => {
            const won = winners.includes(player.index);
            return (
              <li key={player.index} className={`fk-rank${won ? " fk-rank--winner" : ""}`}>
                <span className="fk-rank__place">{player.rank}</span>
                <span className="fk-rank__name">
                  {player.name}
                  {isYou(table, player.index) ? <span className="fk-player__you">You</span> : null}
                  {isBot(table, player.index) ? <span className="fk-player__you fk-player__bot">Bot</span> : null}
                  {won && <span className="fk-sr"> (winner)</span>}
                </span>
                <span className="fk-rank__score">{formatPoints(player.score)}</span>
              </li>
            );
          })}
        </ol>
        {table.online && !connected && (
          <p className="fk-modal__note" role="status">
            Reconnecting… a rematch can be requested once you're back online.
          </p>
        )}
        <div className="fk-modal__actions">
          <button
            ref={againRef}
            type="button"
            className="fk-button fk-button--primary"
            aria-disabled={!canAsk}
            onClick={again}
          >
            {waiting ? "Rematch requested…" : labels.again}
          </button>
          <button type="button" className="fk-button fk-button--ghost" onClick={onNewGame}>
            {labels.leave}
          </button>
        </div>
      </div>
    </div>
  );
}
