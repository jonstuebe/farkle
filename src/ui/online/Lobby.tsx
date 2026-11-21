import { useEffect, useId, useRef, useState } from "react";
import { MAX_SEATS, MIN_SEATS, roomPath, type RoomView } from "../../net/protocol";
import type { LobbyRules } from "../../net/onlineSession";
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
  /** Go back home (the seat is kept). */
  onLeave: () => void;
}

const TARGETS = [2500, 5000, 10_000] as const;
const ENTRY_THRESHOLD = 500;
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
export function Lobby({ room, mySeat, connected, onConfigure, onStart, onCancel, onLeave }: LobbyProps) {
  const isHost = mySeat === HOST_SEAT;
  const uid = useId();
  const linkRef = useRef<HTMLInputElement>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);

  const link = inviteLink(room.code, window.location.origin);
  const host = window.location.host;
  const enough = room.seats.length >= MIN_SEATS;
  const { targetScore, entryThreshold } = room.rules;
  const targets = (TARGETS as readonly number[]).includes(targetScore) ? TARGETS : [...TARGETS, targetScore].sort((a, b) => a - b);

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
    <Screen onBack={onLeave} compact>
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
            </li>
          ))}
          {room.seats.length < MIN_SEATS ? (
            <li className="online__seat online__seat--empty">
              <span className="online__dot" aria-hidden="true" />
              <span className="online__seat-name">Waiting for someone to join…</span>
            </li>
          ) : null}
        </ol>

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
                    <span>{formatScore(value)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="setup__toggle">
              <input
                type="checkbox"
                role="switch"
                className="visually-hidden"
                checked={entryThreshold > 0}
                disabled={!connected}
                onChange={(e) => onConfigure({ entryThreshold: e.target.checked ? ENTRY_THRESHOLD : 0 })}
              />
              <span className="setup__switch" aria-hidden="true" />
              <span className="setup__toggle-text">
                <span className="setup__toggle-title">{formatScore(ENTRY_THRESHOLD)} to get on the board</span>
                <span className="setup__meta">Your first banked turn must score at least {formatScore(ENTRY_THRESHOLD)}</span>
              </span>
            </label>
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
