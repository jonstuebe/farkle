import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  MAX_SEATS,
  MIN_SEATS,
  REACTION_COOLDOWN_MS,
  REACTION_EMOJI,
  REACTION_LABEL,
  REACTIONS,
  roomPath,
  type Reaction,
  type RoomView,
} from "../../net/protocol";
import type { LobbyRules, OnlineSession } from "../../net/onlineSession";
import { TurnAlertsControl } from "./TurnAlertsControl";
import { Screen } from "../setup/Brand";
import "./online.css";

type LobbyRoom = Extract<RoomView, { phase: "lobby" }>;

interface LobbyProps {
  room: LobbyRoom;
  mySeat: number;
  /** False while reconnecting: actions wait. */
  connected: boolean;
  onConfigure: (rules: LobbyRules) => void;
  onStart: () => void;
  /** Host: cancel the invite for everyone. Resolves false if it didn't work. */
  onCancel: () => Promise<boolean>;
  /** Back to the home screen; the game stays in the player's list. */
  onBack: () => void;
  /** Guest: take this game off my list and go home. */
  onLeave: () => void;
  /** Emoji to and from the others in the lobby. */
  reactions?: OnlineSession["reactions"];
  /** For the turn-alerts switch. */
  deviceId?: string;
}

/** 1,000 is the quick game: a few turns each. All within the room's limits (500..100,000). */
const QUICK_TARGET = 1000;
const TARGETS = [QUICK_TARGET, 2500, 5000, 10_000] as const;
const ENTRY_THRESHOLDS = [0, 350, 500] as const;
/** How long a reaction floats next to a name. */
const REACTION_SHOW_MS = 2600;
const HOST_SEAT = 0;

const formatScore = (n: number) => n.toLocaleString("en-US");

/** "K7M 2PQ": two groups are easier to read and to say. */
export const spacedCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`;

/** The invite link for a room on this site. */
export const inviteLink = (code: string, origin: string): string => `${origin}${roomPath(code)}`;

type ShareResult = "shared" | "copied" | "failed";

/** Web Share where there is one, otherwise the clipboard. */
async function shareInvite(code: string, url: string): Promise<ShareResult | "dismissed"> {
  const text = `Join my Farkle game. Code: ${code}`;
  if (typeof navigator.share === "function") {
    try {
      await navigator.share({ title: "Farkle", text, url });
      return "shared";
    } catch (error) {
      // The player closed the share sheet: that's not a failure, and copying behind their back would be odd.
      if (error instanceof DOMException && error.name === "AbortError") return "dismissed";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

/** Waiting room before the game starts: invite people, see who's here, set the rules, start. */
interface Floating {
  id: number;
  seat: number;
  reaction: Reaction;
}

let nextFloatingId = 1;

/** Reactions floating up beside the seats: incoming ones and this device's own. */
function useFloatingReactions(reactions: LobbyProps["reactions"], mySeat: number) {
  const [floating, setFloating] = useState<Floating[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const show = useCallback((seat: number, reaction: Reaction) => {
    const id = nextFloatingId++;
    // At most a few per seat, so a burst can't pile up.
    setFloating((list) => [...list.filter((f) => f.seat !== seat).concat(list.filter((f) => f.seat === seat).slice(-2)), { id, seat, reaction }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFloating((list) => list.filter((f) => f.id !== id));
    }, REACTION_SHOW_MS);
    timers.current.add(timer);
  }, []);
  useEffect(() => reactions?.subscribe(show), [reactions, show]);
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const [coolingDown, setCoolingDown] = useState(false);
  const send = useCallback(
    (reaction: Reaction) => {
      if (!reactions || coolingDown) return;
      reactions.send(reaction);
      show(mySeat, reaction);
      setCoolingDown(true);
      setTimeout(() => setCoolingDown(false), REACTION_COOLDOWN_MS);
    },
    [reactions, coolingDown, show, mySeat],
  );
  return { floating, send, coolingDown };
}

export function Lobby({ room, mySeat, connected, onConfigure, onStart, onCancel, onBack, onLeave, reactions, deviceId }: LobbyProps) {
  const isHost = mySeat === HOST_SEAT;
  const uid = useId();
  const linkRef = useRef<HTMLInputElement>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const { floating, send: react, coolingDown } = useFloatingReactions(reactions, mySeat);
  const [heard, setHeard] = useState("");
  useEffect(
    () => reactions?.subscribe((seat, reaction) => setHeard(`${room.seats[seat]?.name ?? "Someone"}: ${REACTION_LABEL[reaction]}`)),
    [reactions, room.seats],
  );

  const link = inviteLink(room.code, window.location.origin);
  const host = window.location.host;
  const enough = room.seats.length >= MIN_SEATS;
  const { targetScore, entryThreshold } = room.rules;
  const targets = (TARGETS as readonly number[]).includes(targetScore) ? TARGETS : [...TARGETS, targetScore].sort((a, b) => a - b);
  const thresholds = (ENTRY_THRESHOLDS as readonly number[]).includes(entryThreshold)
    ? ENTRY_THRESHOLDS
    : [...ENTRY_THRESHOLDS, entryThreshold].sort((a, b) => a - b);

  useEffect(() => {
    if (shareNote === null) return;
    const timer = setTimeout(() => setShareNote(null), 4000);
    return () => clearTimeout(timer);
  }, [shareNote]);

  const share = async () => {
    const result = await shareInvite(room.code, link);
    if (result === "copied") setShareNote("Link copied. Paste it in a message to your friends.");
    else if (result === "failed") {
      setShareNote("Couldn't copy automatically. Select the link below and copy it.");
      linkRef.current?.focus();
      linkRef.current?.select();
    } else setShareNote(null);
  };

  const cancel = async () => {
    setCancelling(true);
    setCancelFailed(false);
    const ok = await onCancel();
    // On success the room closes and this screen is replaced.
    if (!ok) {
      setCancelling(false);
      setCancelFailed(true);
    }
  };

  return (
    <Screen onBack={onBack} compact>
      <section className="setup__card online__invite" aria-labelledby={`${uid}-invite`}>
        <h2 id={`${uid}-invite`} className="setup__heading">
          {isHost ? "Invite your friends" : "Waiting for the host to start"}
        </h2>
        <p className="online__code" aria-label={`Game code ${room.code.split("").join(" ")}`}>
          <span aria-hidden="true">{spacedCode(room.code)}</span>
        </p>
        <button type="button" className="setup__btn setup__btn--primary" onClick={() => void share()}>
          Share invite
        </button>
        <p className="online__share-note" role="status" aria-live="polite">
          {shareNote}
        </p>
        <input
          ref={linkRef}
          className="setup__input online__link-box"
          type="text"
          readOnly
          value={link}
          aria-label="Invite link"
          onFocus={(e) => e.target.select()}
        />
        <p className="online__aloud">
          Reading it out? “Go to <strong>{host}</strong>, tap <strong>Join with a code</strong>, and enter{" "}
          <strong className="online__aloud-code">{room.code.split("").join(" ")}</strong>.”
        </p>
      </section>

      <section className="setup__card" aria-labelledby={`${uid}-seats`}>
        <h2 id={`${uid}-seats`} className="setup__legend online__legend">
          Players <span className="setup__meta">{room.seats.length} of {MAX_SEATS}</span>
        </h2>
        <ol className="online__seats">
          {room.seats.map((seat, i) => (
            <li key={i} className="online__seat">
              <span
                className={seat.connected ? "online__dot is-on" : "online__dot"}
                role="img"
                aria-label={seat.connected ? "Here now" : "Away"}
              />
              <span className="online__seat-name">{seat.name}</span>
              {i === mySeat ? <span className="online__tag online__tag--you">You</span> : null}
              {i === HOST_SEAT ? <span className="online__tag">Host</span> : null}
              <span className="online__floats" aria-hidden="true">
                {floating
                  .filter((f) => f.seat === i)
                  .map((f) => (
                    <span key={f.id} className="online__float">
                      {REACTION_EMOJI[f.reaction]}
                    </span>
                  ))}
              </span>
            </li>
          ))}
          {room.seats.length < MIN_SEATS ? (
            <li className="online__seat online__seat--empty">
              <span className="online__dot" aria-hidden="true" />
              <span className="online__seat-name">Waiting for someone to join…</span>
            </li>
          ) : null}
        </ol>

        {reactions ? (
          <div className="online__reactions" role="group" aria-label="Send a reaction">
            {REACTIONS.map((reaction) => (
              <button
                key={reaction}
                type="button"
                className="online__reaction"
                onClick={() => react(reaction)}
                disabled={!connected || coolingDown}
                aria-label={REACTION_LABEL[reaction]}
                title={REACTION_LABEL[reaction]}
              >
                <span aria-hidden="true">{REACTION_EMOJI[reaction]}</span>
              </button>
            ))}
          </div>
        ) : null}
        <p className="visually-hidden" role="status" aria-live="polite">
          {heard}
        </p>

        {isHost ? (
          <>
            <fieldset className="setup__group" disabled={!connected}>
              <legend className="setup__legend">Play to</legend>
              <div className="setup__segments" style={{ gridTemplateColumns: `repeat(${targets.length}, minmax(0, 1fr))` }}>
                {targets.map((value) => (
                  <label key={value} className="setup__segment">
                    <input
                      type="radio"
                      name={`${uid}-target`}
                      className="visually-hidden"
                      checked={targetScore === value}
                      onChange={() => onConfigure({ targetScore: value })}
                    />
                    {value === QUICK_TARGET ? (
                      <span className="online__quick-option">
                        <small className="online__quick">Quick</small>
                        {formatScore(value)}
                      </span>
                    ) : (
                      <span>{formatScore(value)}</span>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="setup__group" disabled={!connected}>
              <legend className="setup__legend">To get on the board</legend>
              <div className="setup__segments" style={{ gridTemplateColumns: `repeat(${thresholds.length}, minmax(0, 1fr))` }}>
                {thresholds.map((value) => (
                  <label key={value} className="setup__segment">
                    <input
                      type="radio"
                      name={`${uid}-entry`}
                      className="visually-hidden"
                      checked={entryThreshold === value}
                      onChange={() => onConfigure({ entryThreshold: value })}
                    />
                    <span>{value === 0 ? "Any score" : formatScore(value)}</span>
                  </label>
                ))}
              </div>
              <p className="setup__meta">
                {entryThreshold > 0
                  ? `A player's first banked turn must score at least ${formatScore(entryThreshold)}.`
                  : "Any banked score counts from the first turn."}
              </p>
            </fieldset>
            <button type="button" className="setup__btn setup__btn--start" onClick={onStart} disabled={!enough || !connected}>
              Start game
            </button>
            {!enough ? <p className="online__hint">You need at least {MIN_SEATS} players to start.</p> : null}
          </>
        ) : (
          <p className="online__rules">
            Playing to <strong>{formatScore(targetScore)}</strong>
            {entryThreshold > 0 ? (
              <>
                {" "}
                · <strong>{formatScore(entryThreshold)}</strong> to get on the board
              </>
            ) : null}
            . The game starts when {room.seats[HOST_SEAT]?.name ?? "the host"} is ready; you can close this and come back.
          </p>
        )}
        {!connected ? (
          <p className="online__hint" role="status">
            Reconnecting…
          </p>
        ) : null}
      </section>

      {deviceId ? (
        <section className="setup__card online__alerts-card" aria-label="Turn alerts">
          <TurnAlertsControl deviceId={deviceId} />
        </section>
      ) : null}

      <div className="online__footer">
        {isHost ? (
          confirmCancel ? (
            <div className="online__confirm" role="group" aria-label="Cancel this invite?">
              <span>Cancel this game for everyone?</span>
              <button type="button" className="setup__btn online__btn--danger" onClick={() => void cancel()} disabled={cancelling}>
                {cancelling ? "Cancelling…" : "Yes, cancel it"}
              </button>
              <button type="button" className="setup__btn setup__btn--ghost" onClick={() => setConfirmCancel(false)} disabled={cancelling}>
                Keep it
              </button>
            </div>
          ) : (
            <button type="button" className="online__link" onClick={() => setConfirmCancel(true)}>
              Cancel invite
            </button>
          )
        ) : (
          <button type="button" className="online__link" onClick={onLeave}>
            Leave
          </button>
        )}
        {cancelFailed ? (
          <p className="setup__error" role="alert">
            Couldn't cancel the invite. Check your connection and try again.
          </p>
        ) : null}
      </div>
    </Screen>
  );
}
