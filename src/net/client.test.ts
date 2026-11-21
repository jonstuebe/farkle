import { describe, expect, test } from "vitest";
import { fetchRoomSummary, cancelInvite, parseRoomSummary } from "./api";
import { DEVICE_KEY, NAME_KEY, getDeviceId, getPlayerName, isDeviceId, newDeviceId, setPlayerName } from "./device";
import { DEVICE_ID_MIN_LENGTH, PLAYER_NAME_MAX_LENGTH, roomCodeFromInput, roomCodeFromPath } from "./protocol";
import { isDeviceId as serverAcceptsDeviceId } from "./room";
import { createRouter, parseRoute, routePath, routeState, type Route, type RouterWindow } from "./routes";
import { MAX_SAVED_ROOMS, SAVED_ROOMS_KEY, forgetRoom, loadSavedRooms, rememberRoom } from "./savedRooms";
import type { KeyValueStore } from "./storage";

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

const brokenStore: KeyValueStore = {
  getItem: () => {
    throw new Error("denied");
  },
  setItem: () => {
    throw new Error("quota");
  },
  removeItem: () => {
    throw new Error("denied");
  },
};

describe("device identity", () => {
  test("ids are random, URL-safe, and long enough for the server", () => {
    const ids = new Set(Array.from({ length: 200 }, newDeviceId));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(id.length).toBeGreaterThanOrEqual(DEVICE_ID_MIN_LENGTH);
      expect(isDeviceId(id)).toBe(true);
      expect(serverAcceptsDeviceId(id)).toBe(true);
      expect(encodeURIComponent(id)).toBe(id);
    }
  });

  test("the id is created once and then reused", () => {
    const store = new MemoryStore();
    const id = getDeviceId(store);
    expect(store.getItem(DEVICE_KEY)).toBe(id);
    expect(getDeviceId(store)).toBe(id);
  });

  test("a stored id that is too short or malformed is replaced", () => {
    for (const bad of ["short", "", "has spaces in it, quite long", "x".repeat(200)]) {
      const store = new MemoryStore();
      store.setItem(DEVICE_KEY, bad);
      const id = getDeviceId(store);
      expect(id).not.toBe(bad);
      expect(isDeviceId(id)).toBe(true);
      expect(store.getItem(DEVICE_KEY)).toBe(id);
    }
  });

  test("without storage the id is still stable for the page's lifetime", () => {
    const id = getDeviceId(brokenStore);
    expect(isDeviceId(id)).toBe(true);
    expect(getDeviceId(brokenStore)).toBe(id);
    expect(getDeviceId(null)).toBe(id);
  });

  test("the name is asked once, cleaned, and editable", () => {
    const store = new MemoryStore();
    expect(getPlayerName(store)).toBeNull();
    expect(setPlayerName("   ", store)).toBeNull();
    expect(getPlayerName(store)).toBeNull();
    expect(setPlayerName("  Ada   Lovelace \n", store)).toBe("Ada Lovelace");
    expect(getPlayerName(store)).toBe("Ada Lovelace");
    expect(setPlayerName("x".repeat(80), store)).toHaveLength(PLAYER_NAME_MAX_LENGTH);
    expect(setPlayerName("Bo", store)).toBe("Bo");
    expect(getPlayerName(store)).toBe("Bo");
    store.setItem(NAME_KEY, " \u0000 ");
    expect(getPlayerName(store)).toBeNull();
    expect(getPlayerName(brokenStore)).toBeNull();
    expect(setPlayerName("Cy", brokenStore)).toBe("Cy");
  });
});

describe("room codes", () => {
  test("typed codes: any case, spaces and dashes", () => {
    expect(roomCodeFromInput("abcdef")).toBe("ABCDEF");
    expect(roomCodeFromInput(" abc-def ")).toBe("ABCDEF");
    expect(roomCodeFromInput("AB CD EF")).toBe("ABCDEF");
    expect(roomCodeFromInput("K7M2PQ")).toBe("K7M2PQ");
  });

  test("pasted links", () => {
    expect(roomCodeFromInput("https://farkle.example/r/abcdef")).toBe("ABCDEF");
    expect(roomCodeFromInput("Join my game: https://farkle.example/r/K7M2PQ thanks")).toBe("K7M2PQ");
    expect(roomCodeFromInput("farkle.example/r/K7M2PQ/")).toBe("K7M2PQ");
    expect(roomCodeFromInput("/r/K7M2PQ")).toBe("K7M2PQ");
  });

  test("rejects what can't be a code", () => {
    for (const bad of ["", "ABCDE", "ABCDEFG", "ABCDE0", "ABCDE1", "ABCDEI", "ABCDEO", "https://farkle.example/", "/r/ABCDE0"]) {
      expect(roomCodeFromInput(bad)).toBeNull();
    }
    expect(roomCodeFromPath("/r/ABCDEF/extra")).toBeNull();
    expect(roomCodeFromPath("/x/ABCDEF")).toBeNull();
  });
});

describe("saved rooms", () => {
  test("remember adds to the top; opening again moves it up", () => {
    const store = new MemoryStore();
    expect(loadSavedRooms(store)).toEqual([]);
    rememberRoom("AAAAAA", 100, store);
    rememberRoom("BBBBBB", 200, store);
    expect(loadSavedRooms(store).map((r) => r.code)).toEqual(["BBBBBB", "AAAAAA"]);
    const list = rememberRoom("AAAAAA", 300, store);
    expect(list).toEqual([
      { code: "AAAAAA", openedAt: 300 },
      { code: "BBBBBB", openedAt: 200 },
    ]);
    expect(loadSavedRooms(store)).toEqual(list);
  });

  test("forget removes only that room", () => {
    const store = new MemoryStore();
    rememberRoom("AAAAAA", 1, store);
    rememberRoom("BBBBBB", 2, store);
    expect(forgetRoom("AAAAAA", store)).toEqual([{ code: "BBBBBB", openedAt: 2 }]);
    expect(forgetRoom("CCCCCC", store)).toEqual([{ code: "BBBBBB", openedAt: 2 }]);
    expect(forgetRoom("BBBBBB", store)).toEqual([]);
    expect(loadSavedRooms(store)).toEqual([]);
  });

  test("the list is capped, dropping the oldest", () => {
    const store = new MemoryStore();
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const codes = Array.from({ length: MAX_SAVED_ROOMS + 5 }, (_, i) => `AAAA${letters[Math.floor(i / 32)]}${letters[i % 32]}`);
    codes.forEach((code, i) => rememberRoom(code, i, store));
    const list = loadSavedRooms(store);
    expect(list).toHaveLength(MAX_SAVED_ROOMS);
    expect(list[0]!.code).toBe(codes.at(-1));
    expect(list.map((r) => r.code)).not.toContain(codes[0]);
  });

  test("invalid codes are never stored", () => {
    const store = new MemoryStore();
    expect(rememberRoom("nope", 1, store)).toEqual([]);
    expect(store.getItem(SAVED_ROOMS_KEY)).toBeNull();
  });

  test("corrupt or hand-edited data is tolerated", () => {
    const store = new MemoryStore();
    for (const raw of ["{oops", "null", "42", '{"code":"AAAAAA"}']) {
      store.setItem(SAVED_ROOMS_KEY, raw);
      expect(loadSavedRooms(store)).toEqual([]);
    }
    store.setItem(
      SAVED_ROOMS_KEY,
      JSON.stringify([
        null,
        "AAAAAA",
        { code: "bad" },
        { code: "BBBBBB", openedAt: "yesterday" },
        { code: "CCCCCC", openedAt: 5 },
        { code: "CCCCCC", openedAt: 9 },
      ]),
    );
    expect(loadSavedRooms(store)).toEqual([
      { code: "CCCCCC", openedAt: 5 },
      { code: "BBBBBB", openedAt: 0 },
    ]);
    expect(loadSavedRooms(brokenStore)).toEqual([]);
    expect(() => rememberRoom("AAAAAA", 1, brokenStore)).not.toThrow();
    expect(() => forgetRoom("AAAAAA", brokenStore)).not.toThrow();
  });
});

describe("routes", () => {
  test("parse", () => {
    expect(parseRoute("/")).toEqual({ kind: "home" });
    expect(parseRoute("/", { view: "local" })).toEqual({ kind: "local" });
    expect(parseRoute("/", { view: "join" })).toEqual({ kind: "join" });
    expect(parseRoute("/", { view: "elsewhere" })).toEqual({ kind: "home" });
    expect(parseRoute("/r/abcdef")).toEqual({ kind: "room", code: "ABCDEF", host: false });
    expect(parseRoute("/r/ABCDEF/", { host: true })).toEqual({ kind: "room", code: "ABCDEF", host: true });
    expect(parseRoute("/r/ABCDEF", "host")).toEqual({ kind: "room", code: "ABCDEF", host: false });
    expect(parseRoute("/r/nope")).toEqual({ kind: "home" });
    expect(parseRoute("/somewhere/else", { view: "join" })).toEqual({ kind: "home" });
  });

  test("every route round-trips through its URL and history state", () => {
    const routes: Route[] = [
      { kind: "home" },
      { kind: "local" },
      { kind: "join" },
      { kind: "room", code: "K7M2PQ", host: false },
      { kind: "room", code: "K7M2PQ", host: true },
    ];
    for (const route of routes) {
      const state = JSON.parse(JSON.stringify(routeState(route))) as unknown;
      expect(parseRoute(routePath(route), state)).toEqual(route);
    }
    expect(routePath({ kind: "room", code: "K7M2PQ", host: true })).toBe("/r/K7M2PQ");
  });

  /** A window with a real history stack. */
  function fakeWindow(pathname = "/", state: unknown = null) {
    const entries: { url: string; state: unknown }[] = [{ url: pathname, state }];
    let index = 0;
    const listeners = new Set<() => void>();
    const win: RouterWindow = {
      location: { pathname },
      history: {
        state,
        pushState(next, _unused, url) {
          entries.splice(index + 1);
          entries.push({ url, state: next });
          index += 1;
          sync();
        },
        replaceState(next, _unused, url) {
          entries[index] = { url, state: next };
          sync();
        },
        back() {
          go(-1);
        },
      },
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
    };
    function sync() {
      win.location.pathname = entries[index]!.url;
      win.history.state = entries[index]!.state;
    }
    function go(delta: number) {
      const next = index + delta;
      if (next < 0 || next >= entries.length) return;
      index = next;
      sync();
      for (const listener of [...listeners]) listener();
    }
    return { win, entries, listeners, forward: () => go(1), back: () => go(-1), position: () => index };
  }

  test("push, browser back and forward", () => {
    const w = fakeWindow();
    const router = createRouter(w.win);
    const seen: Route[] = [];
    const stop = router.subscribe(() => seen.push(router.getRoute()));

    router.push({ kind: "join" });
    router.push({ kind: "room", code: "K7M2PQ", host: false });
    expect(w.win.location.pathname).toBe("/r/K7M2PQ");
    expect(w.entries).toHaveLength(3);

    w.back();
    expect(router.getRoute()).toEqual({ kind: "join" });
    w.back();
    expect(router.getRoute()).toEqual({ kind: "home" });
    w.forward();
    expect(router.getRoute()).toEqual({ kind: "join" });
    expect(seen.map((r) => r.kind)).toEqual(["join", "room", "join", "home", "join"]);

    stop();
    expect(w.listeners.size).toBe(0);
  });

  test("pushing the route you are on adds nothing", () => {
    const w = fakeWindow();
    const router = createRouter(w.win);
    let calls = 0;
    router.subscribe(() => calls++);
    router.push({ kind: "home" });
    router.push({ kind: "join" });
    router.push({ kind: "join" });
    expect(w.entries).toHaveLength(2);
    expect(calls).toBe(1);
  });

  test("back() pops what the app pushed", () => {
    const w = fakeWindow();
    const router = createRouter(w.win);
    router.subscribe(() => {});
    router.push({ kind: "local" });
    router.back();
    expect(router.getRoute()).toEqual({ kind: "home" });
    expect(w.position()).toBe(0);
    expect(w.entries).toHaveLength(2); // the forward entry is still there, as in a browser
  });

  test("back() on a deep link replaces the entry instead of leaving the site", () => {
    const w = fakeWindow("/r/K7M2PQ");
    const router = createRouter(w.win);
    router.subscribe(() => {});
    expect(router.getRoute()).toEqual({ kind: "room", code: "K7M2PQ", host: false });
    router.back();
    expect(router.getRoute()).toEqual({ kind: "home" });
    expect(w.entries).toEqual([{ url: "/", state: null }]);
  });

  test("a reload keeps the screen (history state survives)", () => {
    const w = fakeWindow("/", { view: "local" });
    expect(createRouter(w.win).getRoute()).toEqual({ kind: "local" });
    const hosted = fakeWindow("/r/K7M2PQ", { host: true });
    expect(createRouter(hosted.win).getRoute()).toEqual({ kind: "room", code: "K7M2PQ", host: true });
  });

  test("replace swaps the current entry", () => {
    const w = fakeWindow();
    const router = createRouter(w.win);
    router.subscribe(() => {});
    router.push({ kind: "room", code: "K7M2PQ", host: true });
    router.replace({ kind: "home" });
    expect(w.entries.map((e) => e.url)).toEqual(["/", "/"]);
    expect(router.getRoute()).toEqual({ kind: "home" });
  });
});

describe("room summary", () => {
  test("accepts every status the protocol defines", () => {
    const summaries = [
      { status: "missing" },
      { status: "notSeated" },
      { status: "lobby", seats: ["Ada", "Bo"], isHost: true },
      { status: "yourTurn", seats: ["Ada", "Bo"], scores: [100, 0], current: "Ada", unseen: 3 },
      { status: "theirTurn", seats: ["Ada", "Bo"], scores: [100, 0], current: "Bo", unseen: 0 },
      { status: "over", seats: ["Ada", "Bo"], scores: [5000, 300], winners: [0], mySeat: 1 },
    ];
    for (const summary of summaries) expect(parseRoomSummary(summary)).toEqual(summary);
  });

  test("rejects anything else", () => {
    for (const bad of [null, "lobby", 3, {}, { status: "weird" }, { status: "lobby" }, { status: "yourTurn", seats: ["A"], scores: ["x"], current: "A" }, { status: "over", seats: [], scores: [] }]) {
      expect(parseRoomSummary(bad)).toBeNull();
    }
    expect(parseRoomSummary({ status: "theirTurn", seats: ["A"], scores: [1], current: "A", unseen: -4 })).toMatchObject({ unseen: 0 });
  });

  const respond = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status })) as typeof fetch;

  test("fetch: asks the room with this device's id", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ status: "lobby", seats: ["Ada"], isHost: true }));
    }) as typeof fetch;
    expect(await fetchRoomSummary("K7M2PQ", "dev_ice-1234567890ab", { fetch: fake })).toEqual({ status: "lobby", seats: ["Ada"], isHost: true });
    expect(urls).toEqual(["/api/rooms/K7M2PQ/summary?device=dev_ice-1234567890ab"]);
  });

  test("fetch: 404 is a missing room; errors and bad bodies are 'unknown'", async () => {
    expect(await fetchRoomSummary("K7M2PQ", "d", { fetch: respond(404, "nope") })).toEqual({ status: "missing" });
    expect(await fetchRoomSummary("K7M2PQ", "d", { fetch: respond(500, "boom") })).toBeNull();
    expect(await fetchRoomSummary("K7M2PQ", "d", { fetch: respond(200, "<html>") })).toBeNull();
    expect(await fetchRoomSummary("K7M2PQ", "d", { fetch: respond(200, { status: "??" }) })).toBeNull();
    const offline = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await fetchRoomSummary("K7M2PQ", "d", { fetch: offline })).toBeNull();
    expect(await cancelInvite("K7M2PQ", "d", { fetch: offline })).toBe(false);
  });

  test("cancel invite: DELETE, true only when accepted", async () => {
    const calls: [string, string | undefined][] = [];
    const fake = (status: number) =>
      (async (url: string, init?: RequestInit) => {
        calls.push([url, init?.method]);
        return new Response(null, { status });
      }) as typeof fetch;
    expect(await cancelInvite("K7M2PQ", "dev", { fetch: fake(204) })).toBe(true);
    expect(await cancelInvite("K7M2PQ", "dev", { fetch: fake(409) })).toBe(false);
    expect(calls[0]).toEqual(["/api/rooms/K7M2PQ/invite?device=dev", "DELETE"]);
  });
});
