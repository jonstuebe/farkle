import type { GameContext } from "../../game/machine";
import { finalRoundInfo, finalRoundText, formatPoints, isYou, type Table } from "./logic";

export interface ScoreboardProps {
  context: GameContext;
  /** The game is over, so nobody is "up". */
  done: boolean;
  table: Table;
  /** Online: which seats are connected right now. Null in a local game. */
  presence: readonly boolean[] | null;
  rulesOpen: boolean;
  onToggleRules: () => void;
}

export function Scoreboard({ context, done, table, presence, rulesOpen, onToggleRules }: ScoreboardProps) {
  const finalRound = done ? null : finalRoundInfo(context);
  return (
    <section className="fk-panel fk-scoreboard" aria-label="Scoreboard">
      <header className="fk-scoreboard__head">
        <span className="fk-scoreboard__target">
          First to <strong>{formatPoints(context.rules.targetScore)}</strong>
        </span>
        <button
          type="button"
          className="fk-chip-button"
          aria-expanded={rulesOpen}
          aria-controls="fk-rules"
          onClick={onToggleRules}
        >
          Scoring
        </button>
      </header>
      <ol className={`fk-players${context.players.length > 4 ? " fk-players--dense" : ""}`}>
        {context.players.map((player, index) => {
          const current = !done && index === context.current;
          const trigger = context.finalRoundBy === index;
          const you = isYou(table, index);
          // This device's own seat is here by definition, whatever the server last reported.
          const here = presence ? you || presence[index] === true : null;
          return (
            <li
              key={index}
              className={`fk-player${current ? " fk-player--current" : ""}${you ? " fk-player--you" : ""}`}
              aria-current={current ? "true" : undefined}
            >
              <span className="fk-player__marker" aria-hidden="true" />
              {here !== null && (
                <span
                  className={`fk-presence${here ? " fk-presence--here" : ""}`}
                  title={here ? "Connected" : "Away"}
                  aria-hidden="true"
                />
              )}
              <span className="fk-player__name">{player.name}</span>
              {you && <span className="fk-player__you">You</span>}
              {trigger && (
                <span className="fk-player__flag" title="Reached the target score">
                  ★
                </span>
              )}
              <span className="fk-player__score">{formatPoints(player.score)}</span>
              {current && <span className="fk-sr">(rolling now)</span>}
              {here !== null && <span className="fk-sr">{here ? "(connected)" : "(away)"}</span>}
            </li>
          );
        })}
      </ol>
      {finalRound && (
        <p className="fk-final-round">
          <strong>Final round</strong>
          <span>
            <span className="fk-final-round__long">{finalRoundText(finalRound)}</span>
            {/* Shown instead on a crowded phone scoreboard; the banner already said who got there. */}
            <span className="fk-final-round__short" aria-hidden="true">
              {finalRound.remaining.length} turns left
            </span>
          </span>
        </p>
      )}
    </section>
  );
}
