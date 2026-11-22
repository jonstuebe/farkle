/**
 * Turn alerts (Web Push): who the Room tells about a change, and what it says. Pure, like
 * ./room.ts; the Room Durable Object (worker/index.ts) looks up each seat's subscription and
 * sends the notices (worker/webPush.ts).
 *
 * A player is only alerted when the change gives them something to look at (their turn, the
 * game's end) and they have no open socket: an open socket means the game is on their screen.
 * Never one alert per roll.
 */
import { snapshotOf, isDeviceId, type PlayingRoom, type Room } from "./room";
import { roomPath, type PushNotice, type PushRegistration, type PushSubscriptionJson } from "./protocol";

export interface Push {
  seat: number;
  notice: PushNotice;
}

const formatPoints = (points: number): string => points.toLocaleString("en-US");

/** "Ada", "Ada and Bo", "Ada, Bo and Cy". */
const listNames = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const noticeFor = (code: string, title: string, body: string): PushNotice => ({
  title,
  body,
  url: roomPath(code),
  tag: `farkle-${code}`,
});

/** A new game (start or rematch): whoever goes first is told who they're playing. */
function gameStarted(room: PlayingRoom, code: string): Push[] {
  const first = snapshotOf(room).context.current;
  const others = room.input.players.filter((_, i) => i !== first);
  return [{ seat: first, notice: noticeFor(code, "Your turn", `Farkle with ${others.join(", ")}: it's your turn.`) }];
}

/**
 * Who to alert about the change from `before` to `after` (the same room, one message apart).
 * `connected[i]`: seat i has an open socket now; those seats are never alerted. Seats without
 * a push subscription are the caller's to skip.
 */
export function pushesFor(before: Room, after: Room, code: string, connected: readonly boolean[]): Push[] {
  return alertsFor(before, after, code).filter(({ seat }) => !connected[seat]);
}

function alertsFor(before: Room, after: Room, code: string): Push[] {
  if (after.phase !== "playing") return [];
  if (before.phase !== "playing" || before.gameNumber !== after.gameNumber) return gameStarted(after, code);

  const was = snapshotOf(before);
  const now = snapshotOf(after);
  if (was.status !== "active") return [];
  const names = after.input.players;
  const scores = now.context.players.map((p) => p.score);

  if (now.status !== "active") {
    const top = Math.max(...scores);
    const winners = scores.flatMap((score, i) => (score === top ? [i] : []));
    const won = winners.length === 1 ? "wins" : "tie";
    const body = `${listNames(winners.map((i) => names[i] ?? ""))} ${won} with ${formatPoints(top)}.`;
    return names.flatMap((_, seat) => (winners.includes(seat) ? [] : [{ seat, notice: noticeFor(code, "Game over", body) }]));
  }

  const mover = was.context.current;
  const next = now.context.current;
  if (next === mover) return [];

  const banked = (scores[mover] ?? 0) - (was.context.players[mover]?.score ?? 0);
  const moverName = names[mover] ?? "";
  const lead = banked > 0 ? `${moverName} banked ${formatPoints(banked)}.` : `${moverName} farkled.`;
  const reachedBy = now.context.finalRoundBy;
  if (reachedBy === null) return [{ seat: next, notice: noticeFor(code, "Your turn", `${lead} It's your turn.`) }];

  // The final round: everyone after the player who reached the target gets one last turn.
  const reached = `${names[reachedBy] ?? ""} reached ${formatPoints(scores[reachedBy] ?? 0)}. Last turn!`;
  const body = reachedBy === mover ? reached : `${lead} ${reached}`;
  return [{ seat: next, notice: noticeFor(code, "Last turn", body) }];
}

// ---------------------------------------------------------------------------------------------
// Registering a device (POST / DELETE /api/rooms/:code/push)
// ---------------------------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const isKey = (value: unknown): value is string => typeof value === "string" && value.length <= 256 && BASE64URL.test(value);

/** A JSON object body, or null for anything else. */
const parseJsonObject = (text: string): Record<string, unknown> | null => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isObject(value) ? value : null;
};

function parseSubscription(value: unknown): PushSubscriptionJson | null {
  if (!isObject(value) || !isObject(value.keys)) return null;
  const { endpoint } = value;
  const { p256dh, auth } = value.keys;
  if (typeof endpoint !== "string" || endpoint.length > 2048 || !isKey(p256dh) || !isKey(auth)) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return { endpoint, keys: { p256dh, auth } };
}

/** A POST body, built fresh from the known fields; null for anything else. */
export function parsePushRegistration(text: string): PushRegistration | null {
  const value = parseJsonObject(text);
  if (!value || typeof value.device !== "string" || !isDeviceId(value.device)) return null;
  const subscription = parseSubscription(value.subscription);
  return subscription && { device: value.device, subscription };
}

/** A DELETE body: `{device}`. */
export function parsePushRemoval(text: string): { device: string } | null {
  const value = parseJsonObject(text);
  if (!value || typeof value.device !== "string" || !isDeviceId(value.device)) return null;
  return { device: value.device };
}
