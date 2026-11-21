import { useEffect, useId, useState } from "react";
import type { SavedGameSummary } from "../../game/persistence";
import type { RoomSummary } from "../../net/protocol";
import { forgetRoom, loadSavedRooms, type SavedRoom } from "../../net/savedRooms";
import { Screen } from "../setup/Brand";
import { useRoomSummaries, type SummaryState } from "./useRoomSummaries";
import "./online.css";

interface HomeScreenProps {
  deviceId: string;
  /** The online name, if the player has given one. */
  name: string | null;
  /** A local game that can be resumed, shown as a hint on the "this device" button. */
  localGame: SavedGameSummary | null;
  onLocal: () => void;
  onHost: () => void;
  onJoin: () => void;
  onOpenRoom: (code: string) => void;
  onEditName: () => void;
}

const formatScore = (n: number) => n.toLocaleString("en-US");

type Tone = "you" | "wait" | "lobby" | "over" | "muted";

export interface RoomLine {
  /** Short status badge: "Your turn", "Bo's turn", "Lobby", "Over". */
  badge: string;
  tone: Tone;
  /** Who is playing and the scores. */
  detail: string;
  /** "3 new moves", when there is something to watch. */
  news: string | null;
}

const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

const scoreLine = (seats: readonly string[], scores: readonly number[]) =>
  seats.map((seat, i) => `${seat} ${formatScore(scores[i] ?? 0)}`).join(" · ");

/** How a saved room reads in the home-screen list. */
export function describeRoom(summary: SummaryState): RoomLine {
  if (summary === undefined) return { badge: "Checking…", tone: "muted", detail: "", news: null };
  if (summary === null) return { badge: "Offline?", tone: "muted", detail: "Couldn't reach this game just now", news: null };
  return describeSummary(summary);
}

function describeSummary(summary: RoomSummary): RoomLine {
  switch (summary.status) {
    case "missing":
      return { badge: "Gone", tone: "muted", detail: "This game was cancelled or has expired", news: null };
    case "notSeated":
      return { badge: "Not joined", tone: "muted", detail: "You're not a player in this game", news: null };
    case "lobby": {
      const waiting = summary.seats.length < 2 ? "Waiting for players" : summary.isHost ? "Ready when you are" : "Waiting for the host to start";
      return { badge: "Lobby", tone: "lobby", detail: `${summary.seats.join(", ")} · ${waiting}`, news: null };
    }
    case "yourTurn":
    case "theirTurn":
      return {
        badge: summary.status === "yourTurn" ? "Your turn" : `${possessive(summary.current)} turn`,
        tone: summary.status === "yourTurn" ? "you" : "wait",
        detail: scoreLine(summary.seats, summary.scores),
        news: summary.unseen > 0 ? `${summary.unseen} new move${summary.unseen === 1 ? "" : "s"}` : null,
      };
    case "over": {
      const won = summary.winners.includes(summary.mySeat);
      const names = summary.winners.map((i) => summary.seats[i] ?? "?").join(" & ");
      const result = won ? (summary.winners.length > 1 ? "You tied" : "You won") : `${names} won`;
      return { badge: "Over", tone: "over", detail: `${result} · ${scoreLine(summary.seats, summary.scores)}`, news: null };
    }
  }
}

/** First screen: play here, start or join an online game, and pick up online games in progress. */
export function HomeScreen({ deviceId, name, localGame, onLocal, onHost, onJoin, onOpenRoom, onEditName }: HomeScreenProps) {
  const [rooms, setRooms] = useState<SavedRoom[]>(() => loadSavedRooms());
  const summaries = useRoomSummaries(
    rooms.map((room) => room.code),
    deviceId,
  );
  const [announcement, setAnnouncement] = useState("");
  const uid = useId();

  // Another tab may have opened or removed a game.
  useEffect(() => {
    const reload = () => setRooms(loadSavedRooms());
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, []);

  const remove = (code: string) => {
    setRooms(forgetRoom(code));
    setAnnouncement(`Game ${code} removed from your list.`);
  };

  const localHint = localGame
    ? `Game in progress: ${localGame.players.map((p) => `${p.name} ${formatScore(p.score)}`).join(" · ")}`
    : "Pass one phone or tablet around the table";

  return (
    <Screen>
      <nav className="setup__card online__menu" aria-label="Play">
        <button type="button" className="online__choice online__choice--primary" onClick={onLocal}>
          <span className="online__choice-title">Play on this device</span>
          <span className="online__choice-hint">{localHint}</span>
        </button>
        <button type="button" className="online__choice" onClick={onHost}>
          <span className="online__choice-title">Start an online game</span>
          <span className="online__choice-hint">Invite 1 to 7 friends with a code or link</span>
        </button>
        <button type="button" className="online__choice" onClick={onJoin}>
          <span className="online__choice-title">Join with a code</span>
          <span className="online__choice-hint">Got a code or an invite link? Jump in</span>
        </button>
        {name ? (
          <p className="online__identity">
            Playing online as <strong>{name}</strong>
            <button type="button" className="online__link" onClick={onEditName}>
              Change name
            </button>
          </p>
        ) : null}
      </nav>

      {rooms.length > 0 ? (
        <section className="setup__card online__games" aria-labelledby={`${uid}-games`}>
          <h2 id={`${uid}-games`} className="setup__heading">
            Your online games
          </h2>
          <ul className="online__rooms">
            {rooms.map((room) => {
              const line = describeRoom(summaries.get(room.code));
              return (
                <li key={room.code} className="online__room">
                  <button type="button" className="online__room-open" onClick={() => onOpenRoom(room.code)}>
                    <span className="online__room-top">
                      <span className={`online__badge online__badge--${line.tone}`}>{line.badge}</span>
                      {line.news ? <span className="online__news">{line.news}</span> : null}
                      <span className="online__room-code">{room.code}</span>
                    </span>
                    {line.detail ? <span className="online__room-detail">{line.detail}</span> : null}
                  </button>
                  <button
                    type="button"
                    className="setup__icon-btn"
                    onClick={() => remove(room.code)}
                    aria-label={`Remove game ${room.code} from your list`}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="setup__meta">Games are kept on the server while they're being played. Removing one only takes it off this list.</p>
        </section>
      ) : null}

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </Screen>
  );
}
