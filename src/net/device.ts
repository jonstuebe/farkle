/**
 * Who this browser is, for online play. There are no accounts (like jonstuebe/trash): a device is
 * a random id kept in localStorage, and the player's display name is asked once and sent on every
 * connect. Clearing site data makes a new device, which loses its seats.
 */
import { DEVICE_ID_MIN_LENGTH, cleanPlayerName } from "./protocol";
import { defaultStore, readItem, writeItem, type KeyValueStore } from "./storage";

export const DEVICE_KEY = "farkle.device.v1";
export const NAME_KEY = "farkle.name.v1";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEVICE_ID_BYTES = 18; // 144 bits -> 24 base64url characters

export const isDeviceId = (value: unknown): value is string =>
  typeof value === "string" && value.length >= DEVICE_ID_MIN_LENGTH && value.length <= 64 && DEVICE_ID_PATTERN.test(value);

/** A new random device id (CSPRNG, URL-safe). */
export function newDeviceId(): string {
  const bytes = new Uint8Array(DEVICE_ID_BYTES);
  crypto.getRandomValues(bytes);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let id = "";
  // 3 bytes -> 4 characters of 6 bits each.
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    id += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]! + alphabet[(n >> 6) & 63]! + alphabet[n & 63]!;
  }
  return id;
}

let memoryDeviceId: string | null = null;

/** This device's id, created on first use. Stable for as long as site data is kept. */
export function getDeviceId(store: KeyValueStore | null = defaultStore()): string {
  const stored = readItem(store, DEVICE_KEY);
  if (isDeviceId(stored)) return stored;
  const id = newDeviceId();
  // If storage is unavailable, at least stay the same device until the page is closed.
  if (!writeItem(store, DEVICE_KEY, id)) return (memoryDeviceId ??= id);
  return id;
}

/** The player's saved display name, or null if they haven't been asked yet. */
export function getPlayerName(store: KeyValueStore | null = defaultStore()): string | null {
  const stored = readItem(store, NAME_KEY);
  return stored === null ? null : cleanPlayerName(stored);
}

/** Saves the name (cleaned). Returns what was saved, or null if nothing usable was typed. */
export function setPlayerName(raw: string, store: KeyValueStore | null = defaultStore()): string | null {
  const name = cleanPlayerName(raw);
  if (name !== null) writeItem(store, NAME_KEY, name);
  return name;
}
