/**
 * Routing with the History API (no router dependency).
 *
 * Two URLs exist: `/` and `/r/CODE` (a room: lobby or game; also the invite link). The screens
 * that live under `/` (home, local play, join) are told apart by `history.state.view`, so the
 * back button walks through them without them needing shareable URLs.
 */
import { roomCodeFromPath, roomPath } from "./protocol";

export type Route =
  | { kind: "home" }
  /** Pass-and-play on this device: setup screen and the local game. */
  | { kind: "local" }
  | { kind: "join" }
  /** `host`: this device is creating the room (it picked the code). */
  | { kind: "room"; code: string; host: boolean };

interface HistoryState {
  view?: unknown;
  host?: unknown;
}

/** The route for a location. Unknown paths fall back to home. */
export function parseRoute(pathname: string, state: unknown = null): Route {
  const info: HistoryState = typeof state === "object" && state !== null ? (state as HistoryState) : {};
  const code = roomCodeFromPath(pathname);
  if (code) return { kind: "room", code, host: info.host === true };
  if (pathname === "/" || pathname === "") {
    if (info.view === "local") return { kind: "local" };
    if (info.view === "join") return { kind: "join" };
  }
  return { kind: "home" };
}

export function routePath(route: Route): string {
  return route.kind === "room" ? roomPath(route.code) : "/";
}

export function routeState(route: Route): HistoryState | null {
  switch (route.kind) {
    case "home":
      return null;
    case "local":
    case "join":
      return { view: route.kind };
    case "room":
      return route.host ? { host: true } : null;
  }
}

export const sameRoute = (a: Route, b: Route): boolean =>
  a.kind === b.kind && (a.kind !== "room" || (b.kind === "room" && a.code === b.code && a.host === b.host));

/** The bits of `window` the router touches, so tests can pass a fake. */
export interface RouterWindow {
  location: { pathname: string };
  history: {
    state: unknown;
    pushState(state: unknown, unused: string, url: string): void;
    replaceState(state: unknown, unused: string, url: string): void;
    back(): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

export interface Router {
  getRoute(): Route;
  subscribe(listener: () => void): () => void;
  /** Go to a screen, adding a history entry (so Back returns here). */
  push(route: Route): void;
  /** Go to a screen in place of the current history entry. */
  replace(route: Route): void;
  /**
   * Leave the current screen: go back if this app put the previous entry there, otherwise
   * (deep link, reload) replace the current entry with `fallback`.
   */
  back(fallback?: Route): void;
}

export function createRouter(win: RouterWindow): Router {
  const listeners = new Set<() => void>();
  let route = parseRoute(win.location.pathname, win.history.state);
  /** How many entries this app has pushed on top of the one the page was opened on. */
  let depth = 0;

  const set = (next: Route) => {
    if (sameRoute(route, next)) return;
    route = next;
    for (const listener of listeners) listener();
  };

  const onPop = () => {
    depth = Math.max(0, depth - 1);
    set(parseRoute(win.location.pathname, win.history.state));
  };

  return {
    getRoute: () => route,
    subscribe(listener) {
      if (listeners.size === 0) win.addEventListener("popstate", onPop);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) win.removeEventListener("popstate", onPop);
      };
    },
    push(next) {
      if (sameRoute(route, next)) return;
      win.history.pushState(routeState(next), "", routePath(next));
      depth += 1;
      set(next);
    },
    replace(next) {
      win.history.replaceState(routeState(next), "", routePath(next));
      set(next);
    },
    back(fallback = { kind: "home" }) {
      if (depth > 0) {
        win.history.back();
        return;
      }
      win.history.replaceState(routeState(fallback), "", routePath(fallback));
      set(fallback);
    },
  };
}
