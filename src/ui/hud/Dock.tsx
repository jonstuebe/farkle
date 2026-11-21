import { useEffect, useRef } from "react";
import { pendingTurnTotal, selectionScore } from "../../game/machine";
import type { useGameActor } from "../../game/react";
import { actionsFor, formatPoints, needsEntry, turnHint, type ActionButton, type HudView } from "./logic";

type Send = ReturnType<typeof useGameActor>["send"];

export interface DockProps {
  view: HudView;
  send: Send;
  /** Off while another layer (the scoring panel) has the keyboard. */
  shortcutsEnabled: boolean;
}

/** Bottom of the screen: whose turn it is, what the turn is worth, and the action buttons. */
export function Dock({ view, send, shortcutsEnabled }: DockProps) {
  const { phase, context } = view;
  const player = context.players[context.current];
  const actions = actionsFor(view);
  const hint = turnHint(view);
  const selection = phase === "choosing" ? selectionScore(context) : null;
  const invalidPick = phase === "choosing" && context.selected.length > 0 && selection === null;
  const farkled = phase === "farkled";
  const total = farkled ? 0 : pendingTurnTotal(context);
  const actionsRef = useRef<HTMLDivElement>(null);

  const run = (button: ActionButton | null) => {
    if (button?.enabled && button.event) send({ type: button.event });
  };

  // Latest handlers for the key listener, which is attached once.
  const latest = useRef({ actions, run, phase });
  latest.current = { actions, run, phase };

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const inActions = (target: EventTarget | null) =>
      target instanceof Node && actionsRef.current?.contains(target) === true;
    const isControl = (target: EventTarget | null) =>
      target instanceof Element && target.closest("button, a, input, select, textarea, [contenteditable]") !== null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const { actions: now, run: go, phase: at } = latest.current;
      // A focused control outside the action bar keeps its own keys.
      const foreign = isControl(event.target) && !inActions(event.target);
      if (event.code === "Space") {
        if (foreign) return;
        // Space always means "roll", even with the Bank button focused.
        event.preventDefault();
        if (!event.repeat && at !== "farkled") go(now.primary);
      } else if (event.key === "b" || event.key === "B") {
        if (foreign && !(event.target instanceof HTMLButtonElement)) return;
        if (!event.repeat) go(now.bank);
      } else if (event.key === "Enter") {
        // On a focused button, Enter already clicks it.
        if (isControl(event.target)) return;
        if (!event.repeat && at === "farkled") go(now.primary);
      }
    };
    // Buttons click on Space keyup; swallow it so the shortcut above is the only effect.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space" && inActions(event.target)) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [shortcutsEnabled]);

  const primaryKey = farkled ? "Enter" : "Space";

  return (
    <div className="fk-dock">
      <section className={`fk-panel fk-turn${farkled ? " fk-turn--farkled" : ""}`} aria-label="Current turn">
        <div className="fk-turn__who">
          <span className="fk-turn__name">{player?.name}</span>
          <span className={`fk-turn__hint fk-turn__hint--${hint.tone}`}>{hint.text}</span>
        </div>
        <dl className="fk-stats">
          <div className="fk-stat">
            <dt>Turn</dt>
            <dd>{formatPoints(context.turnPoints)}</dd>
          </div>
          <div className={`fk-stat${invalidPick ? " fk-stat--warn" : ""}`}>
            <dt>Picked</dt>
            <dd>{selection === null ? "–" : `+${formatPoints(selection)}`}</dd>
          </div>
          <div className="fk-stat fk-stat--total">
            <dt>To bank</dt>
            <dd>{formatPoints(total)}</dd>
          </div>
        </dl>
        {needsEntry(context) && (
          <p className="fk-turn__entry">
            Needs {formatPoints(context.rules.entryThreshold)} in one turn to get on the board
          </p>
        )}
      </section>
      <div className="fk-actions" ref={actionsRef}>
        {/* aria-disabled rather than disabled, so keyboard focus survives the roll. */}
        <button
          type="button"
          className={`fk-button fk-button--primary${actions.primary.hotDice ? " fk-button--hot" : ""}${
            farkled ? " fk-button--pass" : ""
          }`}
          aria-disabled={!actions.primary.enabled}
          aria-keyshortcuts={primaryKey}
          onClick={() => run(actions.primary)}
        >
          <span className="fk-button__label">{actions.primary.label}</span>
          {actions.primary.enabled && <kbd className="fk-key">{primaryKey}</kbd>}
        </button>
        {actions.bank && (
          <button
            type="button"
            className="fk-button fk-button--bank"
            aria-disabled={!actions.bank.enabled}
            aria-keyshortcuts="B"
            onClick={() => run(actions.bank)}
          >
            <span className="fk-button__label">{actions.bank.label}</span>
            {actions.bank.enabled && <kbd className="fk-key">B</kbd>}
          </button>
        )}
      </div>
    </div>
  );
}
