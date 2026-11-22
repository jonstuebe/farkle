/**
 * Turn alerts, the browser side (modeled on jonstuebe/trash's src/turnAlerts.ts).
 *
 * A device that turns alerts on gets one Web Push subscription (through public/sw.js) and hands
 * it to every online room it is seated in: `POST /api/rooms/:code/push` (see ../net/protocol.ts).
 * The Room then pushes "your turn" to that device when it isn't looking at the game. Turning
 * alerts off unsubscribes and sends `DELETE` to the same rooms.
 *
 * What the player sees is an `AlertStatus`:
 *   on / off            the switch
 *   blocked             notifications are denied for this site (only browser settings can undo it)
 *   unsupported         no service worker / Push API
 *   needsHomeScreen     iOS Safari: push only works in the installed (Home Screen) app
 *   turningOn/Off       waiting for the permission prompt, the push service or the server
 *
 * Bookkeeping (localStorage `farkle.alerts.v1`): whether the player wants alerts, and which rooms
 * already have the current subscription, so opening the app only POSTs to rooms that are new or
 * whose subscription changed (push services rotate endpoints).
 *
 * Everything that touches the browser is in `AlertsEnv`, so tests run the real logic with fakes.
 */
import { VAPID_PUBLIC_KEY, type PushRegistration, type PushSubscriptionJson } from "./protocol";
import { loadSavedRooms } from "./savedRooms";
import { defaultStore, readItem, writeItem, type KeyValueStore } from "./storage";

export type AlertStatus = "unsupported" | "needsHomeScreen" | "blocked" | "off" | "turningOn" | "on" | "turningOff";

export type AlertProblem =
  /** Permission was granted but subscribing or telling the server failed. */
  | "failed"
  /** The player closed the permission prompt without answering. */
  | "dismissed";

export interface AlertState {
  status: AlertStatus;
  /** Why the last attempt didn't work (cleared by the next one). */
  problem: AlertProblem | null;
}

export interface Platform {
  /** Service worker + PushManager + Notification all exist. */
  canPush: boolean;
  isIos: boolean;
  /** Running as an installed app (display-mode standalone). */
  isStandalone: boolean;
}

/** What the switch shows before anything async has happened. */
export function initialStatus(platform: Platform, permission: NotificationPermission, wanted: boolean): AlertStatus {
  if (!platform.canPush) return platform.isIos && !platform.isStandalone ? "needsHomeScreen" : "unsupported";
  if (permission === "denied") return "blocked";
  return permission === "granted" && wanted ? "on" : "off";
}

// ---------------------------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------------------------

export const ALERTS_KEY = "farkle.alerts.v1";

export interface AlertsRecord {
  /** The player turned alerts on (and hasn't turned them off). */
  wanted: boolean;
  /** Room code -> the subscription endpoint that room was last given. */
  rooms: Record<string, string>;
}

const EMPTY_RECORD: AlertsRecord = { wanted: false, rooms: {} };

export function parseAlertsRecord(raw: string | null): AlertsRecord {
  if (!raw) return EMPTY_RECORD;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null) return EMPTY_RECORD;
    const { wanted, rooms } = data as Record<string, unknown>;
    const clean: Record<string, string> = {};
    if (typeof rooms === "object" && rooms !== null) {
      for (const [code, endpoint] of Object.entries(rooms)) if (typeof endpoint === "string") clean[code] = endpoint;
    }
    return { wanted: wanted === true, rooms: clean };
  } catch {
    return EMPTY_RECORD;
  }
}

/** Rooms that don't have this endpoint yet. */
export function roomsToRegister(codes: readonly string[], record: AlertsRecord, endpoint: string): string[] {
  return codes.filter((code) => record.rooms[code] !== endpoint);
}

/** What a POST/DELETE answer means for the bookkeeping. */
export function registrationOutcome(status: number): "ok" | "drop" | "retry" {
  if (status >= 200 && status < 300) return "ok";
  // 404: the room is gone; 403: this device has no seat there; 400: we sent garbage. None of
  // these get better by asking again.
  if (status === 400 || status === 403 || status === 404) return "drop";
  return "retry";
}

// ---------------------------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------------------------

export interface AlertsEnv {
  platform: Platform;
  permission(): NotificationPermission;
  /** Must be called while handling the tap (iOS only shows the prompt then). */
  requestPermission(): Promise<NotificationPermission>;
  /** The current push subscription, if any (registers the service worker if needed). */
  getSubscription(): Promise<PushSubscriptionJson | null>;
  subscribe(): Promise<PushSubscriptionJson>;
  unsubscribe(): Promise<void>;
  /** HTTP status of the request; throws when offline. */
  request(method: "POST" | "DELETE", code: string, body: unknown): Promise<number>;
  /** Codes of the online rooms this device has opened (seated ones are what the server accepts). */
  savedRooms(): string[];
  store: KeyValueStore | null;
}

export class TurnAlerts {
  private state: AlertState;
  private record: AlertsRecord;
  private readonly listeners = new Set<() => void>();
  /** Serialises on/off/sync so a quick double tap can't interleave them. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly env: AlertsEnv,
    private readonly deviceId: string,
  ) {
    this.record = parseAlertsRecord(readItem(env.store, ALERTS_KEY));
    this.state = { status: initialStatus(env.platform, env.platform.canPush ? env.permission() : "default", this.record.wanted), problem: null };
  }

  getState = (): AlertState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Rooms that currently hold this device's subscription (for tests and debugging). */
  registeredRooms(): string[] {
    return Object.keys(this.record.rooms).sort();
  }

  /**
   * Turn alerts on. Call straight from the click handler: the permission prompt is requested
   * synchronously, before any await, because iOS only allows it during the tap.
   */
  turnOn(): Promise<void> {
    if (this.state.status !== "off") return this.queue.then(() => undefined);
    const asked = this.env.permission() === "granted" ? Promise.resolve<NotificationPermission>("granted") : this.env.requestPermission();
    this.set({ status: "turningOn", problem: null });
    return this.run(async () => {
      let permission: NotificationPermission;
      try {
        permission = await asked;
      } catch {
        permission = "default";
      }
      if (permission === "denied") return this.set({ status: "blocked", problem: null });
      if (permission !== "granted") return this.set({ status: "off", problem: "dismissed" });
      let subscription: PushSubscriptionJson;
      try {
        subscription = (await this.env.getSubscription()) ?? (await this.env.subscribe());
      } catch {
        return this.set({ status: "off", problem: "failed" });
      }
      this.save({ wanted: true, rooms: this.record.rooms });
      const ok = await this.registerAll(subscription, this.env.savedRooms());
      // Alerts are on for this device even when a room couldn't be reached right now; the next
      // sync (app start, opening that room) tries it again.
      this.set({ status: "on", problem: ok ? null : "failed" });
    });
  }

  /** Turn alerts off: unsubscribe this device and tell every room to forget it. */
  turnOff(): Promise<void> {
    if (this.state.status !== "on") return this.queue.then(() => undefined);
    this.set({ status: "turningOff", problem: null });
    return this.run(async () => {
      const rooms = Object.keys(this.record.rooms);
      this.save({ wanted: false, rooms: this.record.rooms });
      await Promise.all(
        rooms.map(async (code) => {
          try {
            const status = await this.env.request("DELETE", code, { device: this.deviceId });
            // A room we can't reach keeps the subscription until it expires, but the subscription
            // itself is gone below, so the push service drops whatever it sends.
            if (registrationOutcome(status) !== "retry") this.forget(code);
          } catch {
            this.forget(code);
          }
        }),
      );
      this.save({ wanted: false, rooms: {} });
      try {
        await this.env.unsubscribe();
      } catch {
        // Nothing more to do: with `wanted` false the app won't use it again.
      }
      this.set({ status: this.env.permission() === "denied" ? "blocked" : "off", problem: null });
    });
  }

  /** A room this device was just seated in (join or create). No-op while alerts are off. */
  registerRoom(code: string): Promise<void> {
    return this.run(async () => {
      if (this.state.status !== "on") return;
      const subscription = await this.currentSubscription();
      if (subscription) await this.registerAll(subscription, [code]);
    });
  }

  /**
   * App start: re-check the permission (it can be changed in settings at any time) and bring
   * every saved room up to date with the current subscription.
   */
  sync(): Promise<void> {
    return this.run(async () => {
      const { platform } = this.env;
      if (!platform.canPush) return;
      const permission = this.env.permission();
      if (this.state.status === "on" || this.state.status === "off" || this.state.status === "blocked") {
        this.set({ status: initialStatus(platform, permission, this.record.wanted), problem: this.state.problem });
      }
      if (this.state.status !== "on") return;
      const subscription = await this.currentSubscription();
      if (subscription) await this.registerAll(subscription, this.env.savedRooms());
    });
  }

  // -------------------------------------------------------------------------------------------

  /** The subscription to hand out, making a new one if the browser dropped the old one. */
  private async currentSubscription(): Promise<PushSubscriptionJson | null> {
    try {
      return (await this.env.getSubscription()) ?? (await this.env.subscribe());
    } catch {
      this.set({ status: "on", problem: "failed" });
      return null;
    }
  }

  /** POSTs to the rooms that don't have this subscription yet. True if none failed for a retryable reason. */
  private async registerAll(subscription: PushSubscriptionJson, codes: readonly string[]): Promise<boolean> {
    const todo = roomsToRegister(codes, this.record, subscription.endpoint);
    const body: PushRegistration = { device: this.deviceId, subscription };
    const results = await Promise.all(
      todo.map(async (code) => {
        let status: number;
        try {
          status = await this.env.request("POST", code, body);
        } catch {
          return false;
        }
        const outcome = registrationOutcome(status);
        if (outcome === "ok") this.save({ ...this.record, rooms: { ...this.record.rooms, [code]: subscription.endpoint } });
        else if (outcome === "drop") this.forget(code);
        return outcome !== "retry";
      }),
    );
    return results.every(Boolean);
  }

  private forget(code: string): void {
    if (!(code in this.record.rooms)) return;
    const rooms = { ...this.record.rooms };
    delete rooms[code];
    this.save({ ...this.record, rooms });
  }

  private save(record: AlertsRecord): void {
    this.record = record;
    writeItem(this.env.store, ALERTS_KEY, JSON.stringify(record));
  }

  private set(state: AlertState): void {
    if (state.status === this.state.status && state.problem === this.state.problem) return;
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }

  private run(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => {});
    return next;
  }
}

// ---------------------------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------------------------

/** Served from public/ (also in `vite dev`); see public/sw.js. */
export const SERVICE_WORKER_URL = "/sw.js";
/** A service worker that never activates (blocked, broken) must not hang the switch. */
const READY_TIMEOUT_MS = 8000;

export function isIos(nav: Pick<Navigator, "userAgent" | "platform" | "maxTouchPoints">): boolean {
  // iPadOS reports itself as a Mac, but Macs have no touch screen.
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === "MacIntel" && nav.maxTouchPoints > 1);
}

export const isAndroid = (nav: Pick<Navigator, "userAgent">): boolean => /Android/.test(nav.userAgent);

export function isStandalone(): boolean {
  return (
    (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) ||
    ("standalone" in navigator && (navigator as { standalone?: boolean }).standalone === true)
  );
}

export function browserPlatform(): Platform {
  const canPush =
    typeof navigator !== "undefined" && "serviceWorker" in navigator && typeof window !== "undefined" && "PushManager" in window && "Notification" in window;
  return {
    canPush,
    isIos: typeof navigator !== "undefined" && isIos(navigator),
    isStandalone: typeof window !== "undefined" && isStandalone(),
  };
}

/** Registers public/sw.js (idempotent). Resolves null where there are no service workers. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.register(SERVICE_WORKER_URL).catch(() => null);
}

async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  await registerServiceWorker();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("service worker not ready")), READY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.serviceWorker.ready, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The VAPID public key (base64url) as the bytes `pushManager.subscribe` wants. */
export function applicationServerKey(key: string = VAPID_PUBLIC_KEY): Uint8Array<ArrayBuffer> {
  const base64 = key.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function toJson(subscription: PushSubscription): PushSubscriptionJson {
  const json = subscription.toJSON();
  const { p256dh, auth } = json.keys ?? {};
  if (!json.endpoint || !p256dh || !auth) throw new Error("push subscription without keys");
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

export function browserAlertsEnv(): AlertsEnv {
  return {
    platform: browserPlatform(),
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    async getSubscription() {
      const registration = await readyRegistration();
      const existing = await registration.pushManager.getSubscription();
      return existing ? toJson(existing) : null;
    },
    async subscribe() {
      const registration = await readyRegistration();
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey() });
      return toJson(subscription);
    },
    async unsubscribe() {
      const registration = await readyRegistration();
      await (await registration.pushManager.getSubscription())?.unsubscribe();
    },
    async request(method, code, body) {
      const response = await fetch(`/api/rooms/${encodeURIComponent(code)}/push`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.status;
    },
    savedRooms: () => loadSavedRooms().map((room) => room.code),
    store: defaultStore(),
  };
}

let shared: TurnAlerts | null = null;

/** The app's one controller (created on first use). */
export function turnAlerts(deviceId: string): TurnAlerts {
  return (shared ??= new TurnAlerts(browserAlertsEnv(), deviceId));
}
