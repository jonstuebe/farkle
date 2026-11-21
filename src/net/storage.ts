/** localStorage access that never throws (private mode, quota, disabled storage, tests). */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function defaultStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readItem(store: KeyValueStore | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeItem(store: KeyValueStore | null, key: string, value: string): boolean {
  try {
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(store: KeyValueStore | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // nothing useful to do
  }
}
