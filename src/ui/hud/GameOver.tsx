import { useEffect, useRef } from "react";
import type { Player } from "../../game/machine";
import { formatPoints, rankPlayers, winnerHeadline } from "./logic";

export interface GameOverProps {
  players: readonly Player[];
  winners: readonly number[];
  /** Same players and rules, fresh scores. */
  onPlayAgain: () => void;
  /** Back to the setup screen. */
  onNewGame: () => void;
}

export function GameOver({ players, winners, onPlayAgain, onNewGame }: GameOverProps) {
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
          {winnerHeadline(players, winners)}
        </h2>
        <ol className="fk-ranking">
          {ranked.map((player) => {
            const won = winners.includes(player.index);
            return (
              <li key={player.index} className={`fk-rank${won ? " fk-rank--winner" : ""}`}>
                <span className="fk-rank__place">{player.rank}</span>
                <span className="fk-rank__name">
                  {player.name}
                  {won && <span className="fk-sr"> (winner)</span>}
                </span>
                <span className="fk-rank__score">{formatPoints(player.score)}</span>
              </li>
            );
          })}
        </ol>
        <div className="fk-modal__actions">
          <button ref={againRef} type="button" className="fk-button fk-button--primary" onClick={onPlayAgain}>
            Play again
          </button>
          <button type="button" className="fk-button fk-button--ghost" onClick={onNewGame}>
            New game
          </button>
        </div>
      </div>
    </div>
  );
}
