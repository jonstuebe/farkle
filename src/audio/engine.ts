/**
 * Web Audio plumbing: one lazily created AudioContext, a master gain driven by the mute
 * setting, and the unlock-on-first-gesture dance browsers require. Nothing here throws: without
 * Web Audio (tests, SSR, locked-down browsers) `getOutput()` simply returns null.
 */

const STORAGE_KEY = "farkle:muted";
/** Overall level; individual sounds are mixed relative to this. */
const MASTER_LEVEL = 0.8;

interface Output {
  context: AudioContext;
  /** Connect sounds here. */
  destination: AudioNode;
  /** One second of white noise, shared by every impact sound. */
  noise: AudioBuffer;
}

let output: Output | null = null;
let master: GainNode | null = null;
let failed = false;
let unlocked = false;
let listening = false;
let muted = readMuted();
const subscribers = new Set<() => void>();

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function contextConstructor(): typeof AudioContext | null {
  // SAFETY: only widens globalThis with two optional properties that are read defensively below
  // (Safari's prefixed constructor isn't in lib.dom, and neither exists in Node/SSR).
  const scope = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function create(): Output | null {
  if (output || failed) return output;
  try {
    const Context = contextConstructor();
    if (!Context) {
      failed = true;
      return null;
    }
    const context = new Context({ latencyHint: "interactive" });
    // A gentle limiter so six dice landing together can't clip.
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 12;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.12;
    master = context.createGain();
    master.gain.value = muted ? 0 : MASTER_LEVEL;
    limiter.connect(master);
    master.connect(context.destination);

    const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = noise.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

    output = { context, destination: limiter, noise };
  } catch {
    failed = true;
    output = null;
  }
  return output;
}

function onGesture(): void {
  try {
    unlocked = true;
    const current = create();
    // iOS re-suspends ("interrupted") after backgrounding, so this stays attached for good.
    if (current && current.context.state !== "running") void current.context.resume().catch(() => {});
  } catch {
    // never let audio break input handling
  }
}

/** Starts waiting for the first user gesture. Safe to call repeatedly and without a DOM. */
export function armAudio(): void {
  if (listening || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  listening = true;
  const options = { capture: true, passive: true } as const;
  for (const type of ["pointerdown", "pointerup", "touchend", "keydown", "click"]) {
    window.addEventListener(type, onGesture, options);
  }
}

/**
 * The live output, or null when sound can't or shouldn't play right now (no Web Audio, no user
 * gesture yet, context not running, or muted).
 */
export function getOutput(): Output | null {
  try {
    armAudio();
    if (muted || !unlocked) return null;
    const current = create();
    if (!current || current.context.state !== "running") return null;
    return current;
  } catch {
    return null;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  if (muted === next) return;
  muted = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // private mode / storage disabled: the setting just won't persist
  }
  try {
    if (output && master) {
      const now = output.context.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setTargetAtTime(next ? 0 : MASTER_LEVEL, now, 0.015);
    }
  } catch {
    // ignore
  }
  for (const notify of [...subscribers]) notify();
}

export function subscribeMuted(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}
