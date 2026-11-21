/**
 * Online play protocol, shared by the browser and the Worker (keep it free of DOM and React).
 *
 * Modeled on jonstuebe/trash: one Durable Object ("Room") per invite code; devices identify
 * themselves with a random device id (no accounts) and send their display name on connect.
 * Farkle differences: 2-8 seats, a lobby until the host starts, the server rolls the dice, and
 * the game is shared as an append-only log (see ../game/log.ts) so clients can replay turns
 * they missed.
 *
 * HTTP API (all under /api/rooms/:code/, code = 6 chars from ROOM_CODE_ALPHABET):
 *   GET    socket?device=&name=&intent=host|join   WebSocket upgrade (see messages below)
 *   GET    summary?device=                          RoomSummary JSON (home-screen list)
 *   DELETE invite?device=                           host cancels a room still in the lobby
 */
import type { GameInput, GameRules } from "../game/machine";
import type { Intent, LogEntry } from "../game/log";

// ---------------------------------------------------------------------------------------------
// Room codes and links
// ---------------------------------------------------------------------------------------------

/** No 0/O or 1/I, so a code read aloud can't be misheard. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

export const MIN_SEATS = 2;
export const MAX_SEATS = 8;
export const PLAYER_NAME_MAX_LENGTH = 20;
/** Device ids are random strings of at least this many characters. */
export const DEVICE_ID_MIN_LENGTH = 16;

export const isRoomCode = (value: string): boolean => ROOM_CODE_PATTERN.test(value);

/** In-app path for a room; also the invite link (`${origin}/r/CODE`). */
export const roomPath = (code: string): string => `/r/${code}`;

export function roomCodeFromPath(path: string): string | null {
  const code = /^\/r\/([A-Za-z0-9]+)\/?$/.exec(path)?.[1]?.toUpperCase();
  return code && isRoomCode(code) ? code : null;
}

/** What a player typed on the join screen: a code in any case with spaces/dashes, or a pasted link. */
export function roomCodeFromInput(input: string): string | null {
  const link = /\/r\/([A-Za-z0-9]+)/.exec(input);
  if (link) return roomCodeFromPath(link[0]);
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return isRoomCode(code) ? code : null;
}

/** A new random room code (CSPRNG). The host's device picks it, like trash. */
export function newRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  // 256 is a multiple of 32 (the alphabet size), so `% 32` is unbiased.
  return Array.from(bytes, (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join("");
}

/** Trims, collapses whitespace, strips control characters, caps length. Null if nothing is left. */
export function cleanPlayerName(raw: string): string | null {
  const name = Array.from(raw.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim())
    .slice(0, PLAYER_NAME_MAX_LENGTH)
    .join("")
    .trim();
  return name === "" ? null : name;
}

// ---------------------------------------------------------------------------------------------
// Room state as clients see it
// ---------------------------------------------------------------------------------------------

export interface SeatView {
  name: string;
  /** Has an open socket right now. */
  connected: boolean;
}

export type RoomView =
  | {
      phase: "lobby";
      code: string;
      /** Seat 0 is always the host. */
      seats: SeatView[];
      rules: GameRules;
    }
  | {
      phase: "playing";
      code: string;
      seats: SeatView[];
      /** Increments on every rematch. Logs from different games never mix. */
      gameNumber: number;
      /** Players are named in seat order: `input.players[i]` is seat i. */
      input: GameInput;
      /** The whole log of the current game. */
      log: LogEntry[];
      /**
       * Per seat: how many log entries that player has seen (their replay starts at
       * `seen[mySeat]`). Updated by `seen` messages, so it follows the player across devices.
       */
      seen: number[];
    };

// ---------------------------------------------------------------------------------------------
// WebSocket messages (JSON text frames)
// ---------------------------------------------------------------------------------------------

export type ClientMessage =
  /** Host only, lobby only. */
  | { type: "configure"; rules: Partial<Pick<GameRules, "targetScore" | "entryThreshold">> }
  /** Host only, lobby only, needs MIN_SEATS seated. Deals the first game. */
  | { type: "start" }
  /**
   * Guest only, lobby only: give up this device's seat (later seats move up one; everyone gets
   * a fresh `room`). The server then closes the socket. The host cancels with DELETE invite
   * instead. Once the game has started, seats are permanent and `leave` is ignored.
   */
  | { type: "leave" }
  /**
   * A game move. `seq` is the log length the client saw when the player acted; a stale `seq`
   * (double tap, old screen) is rejected and the client gets the current room back.
   */
  | { type: "intent"; seq: number; intent: Intent }
  /** The player has watched the log up to (not including) `seq`. Never moves backwards. */
  | { type: "seen"; seq: number }
  /** Any seated player, only after the game is over. Starts a new game with the same seats. */
  | { type: "rematch"; gameNumber: number };

export type Refusal =
  /** No room with this code (never created, cancelled, or expired). */
  | "missing"
  /** Lobby already has MAX_SEATS. */
  | "full"
  /** The game started and this device has no seat. */
  | "started";

export type ServerMessage =
  /** Sent on connect and after any lobby/seat change, rematch, or rejected message. */
  | { type: "room"; seat: number; room: RoomView }
  /** New log entries for the current game, in order (`entries[0].seq` = previous log length). */
  | { type: "appended"; gameNumber: number; entries: LogEntry[] }
  /** Someone connected or disconnected. */
  | { type: "presence"; connected: boolean[] }
  /** Sent just before the server closes the socket (close codes below). */
  | { type: "refused"; reason: Refusal };

/** WebSocket close codes the server uses. */
export const CLOSE_REFUSED = 4000;
export const CLOSE_EXPIRED = 4001;
export const CLOSE_CANCELLED = 4002;

// ---------------------------------------------------------------------------------------------
// Home-screen summary (GET summary)
// ---------------------------------------------------------------------------------------------

export type RoomSummary =
  | { status: "missing" }
  | { status: "notSeated" }
  | { status: "lobby"; seats: string[]; isHost: boolean }
  | {
      status: "yourTurn" | "theirTurn";
      seats: string[];
      scores: number[];
      /** Name of the player whose turn it is. */
      current: string;
      /** Entries this device's seat hasn't seen yet (shown as "new moves"). */
      unseen: number;
    }
  | { status: "over"; seats: string[]; scores: number[]; winners: number[]; mySeat: number };

// ---------------------------------------------------------------------------------------------
// Expiry (Durable Object alarm). Every change pushes the deadline back.
// ---------------------------------------------------------------------------------------------

export const DAY_MS = 24 * 60 * 60 * 1000;
export const LOBBY_LIFETIME_MS = 7 * DAY_MS;
export const IDLE_GAME_LIFETIME_MS = 30 * DAY_MS;
export const FINISHED_GAME_LIFETIME_MS = 7 * DAY_MS;
