/**
 * "Your online games": the rooms this device has opened, newest first. Only codes are kept here;
 * what each game looks like right now comes from the room's summary (see ./api.ts).
 */
import { isRoomCode } from "./protocol";
import { defaultStore, readItem, writeItem, type KeyValueStore } from "./storage";

export const SAVED_ROOMS_KEY = "farkle.rooms.v1";
export const MAX_SAVED_ROOMS = 30;

export interface SavedRoom {
  code: string;
  /** `Date.now()` when this device last opened the room. */
  openedAt: number;
}

function parse(raw: string | null): SavedRoom[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const rooms: SavedRoom[] = [];
  for (const item of data as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { code, openedAt } = item as Record<string, unknown>;
    if (typeof code !== "string" || !isRoomCode(code) || seen.has(code)) continue;
    seen.add(code);
    rooms.push({ code, openedAt: typeof openedAt === "number" && Number.isFinite(openedAt) ? openedAt : 0 });
  }
  return rooms.sort((a, b) => b.openedAt - a.openedAt).slice(0, MAX_SAVED_ROOMS);
}

export function loadSavedRooms(store: KeyValueStore | null = defaultStore()): SavedRoom[] {
  return parse(readItem(store, SAVED_ROOMS_KEY));
}

function save(rooms: SavedRoom[], store: KeyValueStore | null): SavedRoom[] {
  writeItem(store, SAVED_ROOMS_KEY, JSON.stringify(rooms));
  return rooms;
}

/** Adds the room or moves it to the top. Returns the new list. */
export function rememberRoom(code: string, now: number = Date.now(), store: KeyValueStore | null = defaultStore()): SavedRoom[] {
  if (!isRoomCode(code)) return loadSavedRooms(store);
  const others = loadSavedRooms(store).filter((room) => room.code !== code);
  return save([{ code, openedAt: now }, ...others].slice(0, MAX_SAVED_ROOMS), store);
}

/** Removes the room from this device's list (the game itself is untouched). Returns the new list. */
export function forgetRoom(code: string, store: KeyValueStore | null = defaultStore()): SavedRoom[] {
  return save(
    loadSavedRooms(store).filter((room) => room.code !== code),
    store,
  );
}
