import { describe, expect, test } from "vitest";
import type { PushSubscriptionJson } from "./protocol";
import {
  ALERTS_KEY,
  TurnAlerts,
  applicationServerKey,
  initialStatus,
  isIos,
  parseAlertsRecord,
  registrationOutcome,
  roomsToRegister,
  type AlertsEnv,
  type Platform,
} from "./turnAlerts";
import type { KeyValueStore } from "./storage";

const DEVICE = "device-0000000000000000";
const PHONE: Platform = { canPush: true, isIos: false, isStandalone: false };

class MemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  getItem = (key: string) => this.data.get(key) ?? null;
  setItem = (key: string, value: string) => void this.data.set(key, value);
  removeItem = (key: string) => void this.data.delete(key);
}

const sub = (n: number): PushSubscriptionJson => ({ endpoint: `https://push.example/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

/** A browser + server where everything works unless a test says otherwise. */
function fakeEnv(overrides: Partial<AlertsEnv> = {}) {
  const calls: string[] = [];
  const state = {
    permission: "default" as NotificationPermission,
    answer: "granted" as NotificationPermission,
    subscription: null as PushSubscriptionJson | null,
    nextSubscription: 1,
    /** Status the server answers per room (204 when not listed). */
    statuses: new Map<string, number>(),
    offline: false,
    rooms: ["AAAAAA", "BBBBBB"],
  };
  const store = new MemoryStore();
  const env: AlertsEnv = {
    platform: PHONE,
    permission: () => state.permission,
    requestPermission: () => {
      calls.push("prompt");
      state.permission = state.answer;
      return Promise.resolve(state.answer);
    },
    getSubscription: async () => state.subscription,
    subscribe: async () => {
      calls.push("subscribe");
      state.subscription = sub(state.nextSubscription++);
      return state.subscription;
    },
    unsubscribe: async () => {
      calls.push("unsubscribe");
      state.subscription = null;
    },
    request: async (method, code, body) => {
      if (state.offline) throw new TypeError("offline");
      calls.push(`${method} ${code} ${JSON.stringify(body)}`);
      return state.statuses.get(code) ?? 204;
    },
    savedRooms: () => state.rooms,
    store,
    ...overrides,
  };
  return { env, state, calls, store };
}

describe("initial status", () => {
  test.each([
    [{ canPush: false, isIos: true, isStandalone: false }, "default", false, "needsHomeScreen"],
    [{ canPush: false, isIos: true, isStandalone: true }, "default", false, "unsupported"],
    [{ canPush: false, isIos: false, isStandalone: false }, "default", false, "unsupported"],
    [PHONE, "denied", true, "blocked"],
    [PHONE, "granted", false, "off"],
    [PHONE, "granted", true, "on"],
    [PHONE, "default", true, "off"],
  ] as const)("%o, permission %s, wanted %s -> %s", (platform, permission, wanted, expected) => {
    expect(initialStatus(platform, permission, wanted)).toBe(expected);
  });

  test("detects iPads that call themselves Macs", () => {
    expect(isIos({ userAgent: "iPhone", platform: "iPhone", maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isIos({ userAgent: "Macintosh", platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
  });

  test("the VAPID key decodes to an uncompressed P-256 point", () => {
    const key = applicationServerKey();
    expect(key).toHaveLength(65);
    expect(key[0]).toBe(4);
  });
});

describe("bookkeeping", () => {
  test("stored records are untrusted", () => {
    expect(parseAlertsRecord(null)).toEqual({ wanted: false, rooms: {} });
    expect(parseAlertsRecord("{")).toEqual({ wanted: false, rooms: {} });
    expect(parseAlertsRecord('{"wanted":"yes","rooms":{"AAAAAA":"e","BBBBBB":5}}')).toEqual({ wanted: false, rooms: { AAAAAA: "e" } });
  });

  test("only rooms without the current endpoint need a POST", () => {
    const record = { wanted: true, rooms: { AAAAAA: "e1", BBBBBB: "e0" } };
    expect(roomsToRegister(["AAAAAA", "BBBBBB", "CCCCCC"], record, "e1")).toEqual(["BBBBBB", "CCCCCC"]);
  });

  test("server answers", () => {
    expect(registrationOutcome(204)).toBe("ok");
    expect(registrationOutcome(404)).toBe("drop");
    expect(registrationOutcome(403)).toBe("drop");
    expect(registrationOutcome(400)).toBe("drop");
    expect(registrationOutcome(500)).toBe("retry");
  });
});

describe("turning alerts on and off", () => {
  test("on: asks once, subscribes, and registers every saved room", async () => {
    const { env, calls, store } = fakeEnv();
    const alerts = new TurnAlerts(env, DEVICE);
    expect(alerts.getState().status).toBe("off");
    const done = alerts.turnOn();
    // The prompt is requested synchronously, inside the tap.
    expect(calls).toEqual(["prompt"]);
    expect(alerts.getState().status).toBe("turningOn");
    await done;
    expect(alerts.getState()).toEqual({ status: "on", problem: null });
    expect(calls).toEqual([
      "prompt",
      "subscribe",
      `POST AAAAAA ${JSON.stringify({ device: DEVICE, subscription: sub(1) })}`,
      `POST BBBBBB ${JSON.stringify({ device: DEVICE, subscription: sub(1) })}`,
    ]);
    expect(alerts.registeredRooms()).toEqual(["AAAAAA", "BBBBBB"]);
    expect(JSON.parse(store.getItem(ALERTS_KEY)!).wanted).toBe(true);
  });

  test("on: a denied prompt is Blocked; a dismissed one stays Off with a note", async () => {
    const denied = fakeEnv();
    denied.state.answer = "denied";
    const a = new TurnAlerts(denied.env, DEVICE);
    await a.turnOn();
    expect(a.getState()).toEqual({ status: "blocked", problem: null });

    const dismissed = fakeEnv();
    dismissed.state.answer = "default";
    const b = new TurnAlerts(dismissed.env, DEVICE);
    await b.turnOn();
    expect(b.getState()).toEqual({ status: "off", problem: "dismissed" });
    expect(dismissed.calls).toEqual(["prompt"]);
  });

  test("on: a push service failure stays Off and says so", async () => {
    const { env } = fakeEnv({ subscribe: () => Promise.reject(new Error("no push service")) });
    const alerts = new TurnAlerts(env, DEVICE);
    await alerts.turnOn();
    expect(alerts.getState()).toEqual({ status: "off", problem: "failed" });
  });

  test("on: rooms that are gone are dropped, unreachable ones retried at the next sync", async () => {
    const { env, state, calls } = fakeEnv();
    state.rooms = ["AAAAAA", "BBBBBB", "CCCCCC"];
    state.statuses.set("BBBBBB", 404).set("CCCCCC", 503);
    const alerts = new TurnAlerts(env, DEVICE);
    await alerts.turnOn();
    expect(alerts.getState()).toEqual({ status: "on", problem: "failed" });
    expect(alerts.registeredRooms()).toEqual(["AAAAAA"]);

    state.statuses.clear();
    calls.length = 0;
    await alerts.sync();
    // Already registered rooms aren't asked again.
    expect(calls.map((c) => c.slice(0, 11))).toEqual(["POST BBBBBB", "POST CCCCCC"]);
    expect(alerts.registeredRooms()).toEqual(["AAAAAA", "BBBBBB", "CCCCCC"]);
  });

  test("off: DELETE to every registered room, then unsubscribe", async () => {
    const { env, calls, store } = fakeEnv();
    const alerts = new TurnAlerts(env, DEVICE);
    await alerts.turnOn();
    calls.length = 0;
    await alerts.turnOff();
    expect(calls.sort()).toEqual([`DELETE AAAAAA {"device":"${DEVICE}"}`, `DELETE BBBBBB {"device":"${DEVICE}"}`, "unsubscribe"]);
    expect(alerts.getState()).toEqual({ status: "off", problem: null });
    expect(JSON.parse(store.getItem(ALERTS_KEY)!)).toEqual({ wanted: false, rooms: {} });
  });

  test("off while offline still turns off on this device", async () => {
    const { env, state, calls } = fakeEnv();
    const alerts = new TurnAlerts(env, DEVICE);
    await alerts.turnOn();
    state.offline = true;
    await alerts.turnOff();
    expect(alerts.getState().status).toBe("off");
    expect(calls.at(-1)).toBe("unsubscribe");
  });

  test("a double tap doesn't ask twice", async () => {
    const { env, calls } = fakeEnv();
    const alerts = new TurnAlerts(env, DEVICE);
    const first = alerts.turnOn();
    const second = alerts.turnOn();
    await Promise.all([first, second]);
    expect(calls.filter((c) => c === "prompt" || c === "subscribe")).toEqual(["prompt", "subscribe"]);
  });
});

describe("rooms and app start", () => {
  test("joining or creating a room registers it, but only while alerts are on", async () => {
    const { env, state, calls } = fakeEnv();
    state.rooms = [];
    const alerts = new TurnAlerts(env, DEVICE);
    await alerts.registerRoom("DDDDDD");
    expect(calls).toEqual([]);
    await alerts.turnOn();
    await alerts.registerRoom("DDDDDD");
    await alerts.registerRoom("DDDDDD");
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    expect(alerts.registeredRooms()).toEqual(["DDDDDD"]);
  });

  test("a new endpoint (the push service rotated it) is sent to every room again", async () => {
    const { env, state, calls } = fakeEnv();
    const alerts = new TurnAlerts(env, DEVICE);
    await alerts.turnOn();
    state.subscription = sub(9);
    calls.length = 0;
    await alerts.sync();
    expect(calls.filter((c) => c.includes("push.example/9"))).toHaveLength(2);
  });

  test("the browser dropped the subscription: sync makes a new one", async () => {
    const { env, state, calls } = fakeEnv();
    const alerts = new TurnAlerts(env, DEVICE);
    await alerts.turnOn();
    state.subscription = null;
    calls.length = 0;
    await alerts.sync();
    expect(calls[0]).toBe("subscribe");
  });

  test("permission revoked in settings: the next start shows Blocked; re-granted shows On again", async () => {
    const { env, state, store } = fakeEnv();
    await new TurnAlerts(env, DEVICE).turnOn();
    state.permission = "denied";
    const later = new TurnAlerts(env, DEVICE);
    expect(later.getState().status).toBe("blocked");
    state.permission = "granted";
    await later.sync();
    expect(later.getState().status).toBe("on");
    expect(JSON.parse(store.getItem(ALERTS_KEY)!).wanted).toBe(true);
  });

  test("permission granted but alerts turned off here stays Off", async () => {
    const { env, state } = fakeEnv();
    const alerts = new TurnAlerts(env, DEVICE);
    await alerts.turnOn();
    await alerts.turnOff();
    expect(state.permission).toBe("granted");
    expect(new TurnAlerts(env, DEVICE).getState().status).toBe("off");
  });
});
