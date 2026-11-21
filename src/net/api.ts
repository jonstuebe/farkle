/** HTTP calls to a room (everything that isn't the WebSocket). */
import type { RoomSummary } from "./protocol";

const roomUrl = (code: string, path: string, deviceId: string): string =>
  `/api/rooms/${encodeURIComponent(code)}/${path}?device=${encodeURIComponent(deviceId)}`;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === "number");

/** Checks a summary response's shape. Anything unexpected is null (shown as "couldn't check"). */
export function parseRoomSummary(data: unknown): RoomSummary | null {
  if (typeof data !== "object" || data === null) return null;
  const s = data as Record<string, unknown>;
  switch (s.status) {
    case "missing":
      return { status: "missing" };
    case "notSeated":
      return { status: "notSeated" };
    case "lobby":
      return isStringArray(s.seats) ? { status: "lobby", seats: s.seats, isHost: s.isHost === true } : null;
    case "yourTurn":
    case "theirTurn":
      if (!isStringArray(s.seats) || !isNumberArray(s.scores) || typeof s.current !== "string") return null;
      return {
        status: s.status,
        seats: s.seats,
        scores: s.scores,
        current: s.current,
        unseen: typeof s.unseen === "number" && s.unseen > 0 ? Math.floor(s.unseen) : 0,
      };
    case "over":
      if (!isStringArray(s.seats) || !isNumberArray(s.scores) || !isNumberArray(s.winners)) return null;
      return {
        status: "over",
        seats: s.seats,
        scores: s.scores,
        winners: s.winners,
        mySeat: typeof s.mySeat === "number" ? s.mySeat : -1,
      };
    default:
      return null;
  }
}

/** The room's status for the home-screen list. Null when it couldn't be fetched (offline, 5xx). */
export async function fetchRoomSummary(
  code: string,
  deviceId: string,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<RoomSummary | null> {
  try {
    const response = await (options.fetch ?? fetch)(roomUrl(code, "summary", deviceId), { signal: options.signal });
    if (response.status === 404) return { status: "missing" };
    if (!response.ok) return null;
    return parseRoomSummary(await response.json());
  } catch {
    return null;
  }
}

/** Host cancels a room that is still in the lobby. True if the server accepted it. */
export async function cancelInvite(code: string, deviceId: string, options: { fetch?: typeof fetch } = {}): Promise<boolean> {
  try {
    const response = await (options.fetch ?? fetch)(roomUrl(code, "invite", deviceId), { method: "DELETE" });
    return response.ok;
  } catch {
    return false;
  }
}
