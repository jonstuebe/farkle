import { useEffect, useRef } from "react";
import { pendingTurnTotal, selectionScore } from "../../game/machine";
import type { Intent } from "../../game/log";
import {
  actionsFor,
  blockedReason,
  formatPoints,
  isMyTurn,
  needsEntry,
  replayStatus,
  turnHint,
  turnTitle,
  upNextText,
  watchingHint,
  type ActionButton,
  type Hint,
  type HudView,
  type Table,
} from "./logic";

type Send = (intent: Intent) => void;

export interface DockReplay {
  replaying: boolean;
  fed: number;
  total: number;
  skip: () => void;
}

export interface DockProps {
  view: HudView;
  send: Send;
  table: Table;
  /** False while it isn't this device's turn or a throw/replay is still playing out. */
  canAct: boolean;
  /** Online only: false while the socket is reconnecting. */
  connected: boolean;
  /** Online only: the player whose turn it is has no open connection right now. */
  currentAway: boolean;
  replay: DockReplay;
  /** Off while another layer (the scoring panel) has the keyboard. */
  shortcutsEnabled: boolean;
}

const isControl = (target: EventTarget | null) =>
  target instanceof Element && target.closest("button, a, input, select, textarea, [contenteditable]") !== null;

/**
 * Bottom of the screen: whose turn it is, what the turn is worth, and one of three things below
 * it. My turn (always, in a local game): the action buttons. Someone else's turn online: what
 * they are doing and when I'm up. Catching up on missed moves: replay progress and Skip.
 */
export function Dock({ view, send, table, canAct, connected, currentAway, replay, shortcutsEnabled }: DockProps) {
  const { phase, context } = view;
  const player = context.players[context.current];
  const myTurn = isMyTurn(view, table);
  const mode = replay.replaying ? "replay" : myTurn ? "act" : "watch";

  const offered = actionsFor(view);
  const gate = (button: ActionButton): ActionButton => (canAct ? button : { ...button, enabled: false });
  const actions = { primary: gate(offered.primary), bank: offered.bank && gate(offered.bank) };

  let hint: Hint;
  if (mode === "act") {
    const blocked = blockedReason(view, connected);
    hint = blocked ? { tone: "warn", text: blocked } : turnHint(view);
  } else {
    // Replays show what happened, not who is around now.
    hint = watchingHint(view, mode === "watch" && currentAway);
  }

  const selection = phase === "choosing" ? selectionScore(context) : null;
  const invalidPick = phase === "choosing" && context.selected.length > 0 && selection === null;
  const farkled = phase === "farkled";
  const total = farkled ? 0 : pendingTurnTotal(context);
  const actionsRef = useRef<HTMLDivElement>(null);

  const run = (button: ActionButton | null) => {
    if (mode === "act" && button?.enabled && button.event) send({ type: button.event });
  };

  // Latest handlers for the key listener, which is attached once.
  const latest = useRef({ actions, run, phase, mode, skip: replay.skip });
  latest.current = { actions, run, phase, mode, skip: replay.skip };

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const inActions = (target: EventTarget | null) =>
      target instanceof Node && actionsRef.current?.contains(target) === true;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const { actions: now, run: go, phase: at, mode: doing, skip } = latest.current;
      // A focused control outside the action bar keeps its own keys.
      const foreign = isControl(event.target) && !inActions(event.target);

      if (doing === "replay") {
        const typing = event.target instanceof Element && event.target.closest("input, select, textarea, [contenteditable]");
        if ((event.key === "s" || event.key === "S") && !typing && !event.repeat) skip();
        // Don't let Space scroll or re-click anything while the dock is showing the replay.
        if (event.code === "Space" && !foreign) event.preventDefault();
        return;
      }
      if (doing !== "act") return;

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
  const status = replayStatus(view, table, replay.fed, replay.total);
  const upNext = upNextText(view, table);

  return (
    <div className={`fk-dock fk-dock--${mode}`}>
      <section className={`fk-panel fk-turn${farkled ? " fk-turn--farkled" : ""}`} aria-label="Current turn">
        <div className="fk-turn__who">
          <span className="fk-turn__name">{table.online ? turnTitle(view, table) : player?.name}</span>
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
        {mode === "act" && needsEntry(context) && (
          <p className="fk-turn__entry">
            Needs {formatPoints(context.rules.entryThreshold)} in one turn to get on the board
          </p>
        )}
      </section>

      {mode === "replay" && (
        <section className="fk-panel fk-replay" aria-label="Replay of moves you missed">
          <div className="fk-replay__info">
            <span className="fk-replay__text">{status.text}</span>
            <span className="fk-replay__detail">{status.detail}</span>
            <div
              className="fk-replay__bar"
              role="progressbar"
              aria-label="Replay progress"
              aria-valuemin={0}
              aria-valuemax={replay.total}
              aria-valuenow={Math.min(replay.fed, replay.total)}
            >
              <span style={{ transform: `scaleX(${status.progress})` }} />
            </div>
          </div>
          <button type="button" className="fk-button fk-button--skip" aria-keyshortcuts="S" onClick={replay.skip}>
            <span className="fk-button__label">Skip</span>
            <kbd className="fk-key">S</kbd>
          </button>
        </section>
      )}

      {mode === "watch" && (
        <p className="fk-panel fk-waiting">
          <span className="fk-waiting__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            Not your turn{upNext ? "." : ""}
            {upNext && <strong> {upNext}</strong>}
          </span>
        </p>
      )}

      {mode === "act" && (
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
      )}
    </div>
  );
}
