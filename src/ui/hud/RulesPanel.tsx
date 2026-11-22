import { useEffect, useRef } from "react";
import type { GameRules } from "../../game/machine";
import { formatPoints, scoringRows } from "./logic";

export interface RulesPanelProps {
  rules: GameRules;
  onClose: () => void;
}

/** Scoring reference, generated from the rules in play so house rules show correctly. */
export function RulesPanel({ rules, onClose }: RulesPanelProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const rows = scoringRows(rules.scoring);

  useEffect(() => {
    // Hand focus back to whatever opened the panel (the Scoring button).
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, [onClose]);

  return (
    <aside id="fk-rules" className="fk-panel fk-rules" aria-label="Scoring reference">
      <header className="fk-rules__head">
        <h2 className="fk-rules__title">Scoring</h2>
        <button ref={closeRef} type="button" className="fk-chip-button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="fk-rules__body">
        <table className="fk-rules__table">
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.label} className={row.sixDice && !rows[i - 1]?.sixDice ? "fk-rules__break" : undefined}>
                <th scope="row">
                  <span className="fk-rules__label">{row.label}</span>
                  <span className="fk-pips" aria-hidden="true">
                    {row.dice.map((face, n) => (
                      <span key={n} className="fk-pip">
                        {face}
                      </span>
                    ))}
                  </span>
                </th>
                <td>{formatPoints(row.points)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="fk-rules__notes">
          <li>The last four combinations need all six dice in one roll.</li>
          <li>
            Combinations only count within a single roll: dice kept from different rolls never add up. Three 5s
            kept over three rolls are {formatPoints(rules.scoring.singleFive)} each, not{" "}
            {formatPoints(rules.scoring.threeOfAKindMultiplier * 5)}.
          </li>
          <li>Every die you keep must score. No scoring dice in a roll is a farkle: the turn's points are lost.</li>
          <li>Score with all six dice (hot dice) and you roll all six again.</li>
          <li>
            Reaching {formatPoints(rules.targetScore)} starts the final round: everyone else gets one more turn.
          </li>
          {rules.entryThreshold > 0 && (
            <li>Your first bank must be at least {formatPoints(rules.entryThreshold)} points in a single turn.</li>
          )}
        </ul>
      </div>
    </aside>
  );
}
