/**
 * "Add to Home Screen". Installed, Farkle opens full screen and (on iOS, only then) can send
 * turn alerts. Phones only, like jonstuebe/trash: a desktop browser can install it too, but
 * nothing needs it there.
 *
 *   iOS        no API: show the Share -> Add to Home Screen steps
 *   Android    Chrome fires `beforeinstallprompt`; keep it and offer an Install button
 *              (and show the menu steps if it never fires)
 */
import { isAndroid, isIos, isStandalone } from "./turnAlerts";

export type InstallKind = "installed" | "ios" | "android" | "unavailable";

export function installKindFor(platform: { standalone: boolean; ios: boolean; android: boolean }): InstallKind {
  if (platform.standalone) return "installed";
  if (platform.ios) return "ios";
  return platform.android ? "android" : "unavailable";
}

export const installKind = (): InstallKind =>
  installKindFor({ standalone: isStandalone(), ios: isIos(navigator), android: isAndroid(navigator) });

/** Chrome's install prompt event (not in lib.dom). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

/** Call once at startup, before React renders: the event fires early and only once. */
export function captureInstallPrompt(): void {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Keep Chrome's mini-infobar away; the home screen offers it at a better moment.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    changed();
  });
}

export const canPromptInstall = (): boolean => deferred !== null;

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shows Chrome's install dialog. True if the player installed. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  // A prompt event can only be used once.
  deferred = null;
  changed();
  await event.prompt();
  return (await event.userChoice).outcome === "accepted";
}
