/**
 * Sound effects, synthesised with Web Audio (no audio files).
 * Callers may invoke these freely (including on every physics contact): they are cheap, throttle
 * themselves, cap the number of simultaneous voices, and never throw. Until the user has
 * interacted with the page (browser autoplay rules) or while muted, they do nothing.
 */
import { armAudio, getOutput } from "./engine";
import { clampStrength, createHitGate, hitGain, vary, type Surface } from "./throttle";

armAudio();

type Output = NonNullable<ReturnType<typeof getOutput>>;

/** Runs a sound, swallowing anything Web Audio might throw. */
function safely(play: (output: Output) => void): void {
  try {
    const output = getOutput();
    if (output) play(output);
  } catch {
    // sound is never worth breaking the game for
  }
}

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

interface NoiseBurst {
  at: number;
  gain: number;
  /** Seconds for the burst to die away. */
  decay: number;
  filter: BiquadFilterType;
  frequency: number;
  q: number;
}

function noiseBurst({ context, destination, noise }: Output, burst: NoiseBurst): void {
  const source = context.createBufferSource();
  source.buffer = noise;
  const filter = context.createBiquadFilter();
  filter.type = burst.filter;
  filter.frequency.value = burst.frequency;
  filter.Q.value = burst.q;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, burst.at);
  envelope.gain.linearRampToValueAtTime(burst.gain, burst.at + 0.0015);
  envelope.gain.exponentialRampToValueAtTime(0.0001, burst.at + burst.decay);
  source.connect(filter).connect(envelope).connect(destination);
  // A random slice of the shared buffer, so no two bursts are sample-identical.
  source.start(burst.at, Math.random() * (noise.duration - burst.decay - 0.05), burst.decay + 0.03);
  source.onended = () => envelope.disconnect();
}

interface Tone {
  at: number;
  frequency: number;
  /** Glide to this frequency over the tone's length. */
  glideTo?: number;
  type?: OscillatorType;
  gain: number;
  attack?: number;
  decay: number;
  /** Cents; a second, detuned oscillator adds warmth when set. */
  detune?: number;
}

function tone({ context, destination }: Output, spec: Tone): void {
  const attack = spec.attack ?? 0.004;
  const end = spec.at + attack + spec.decay;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0, spec.at);
  envelope.gain.linearRampToValueAtTime(spec.gain, spec.at + attack);
  envelope.gain.exponentialRampToValueAtTime(0.0001, end);
  envelope.connect(destination);
  const detunes = spec.detune ? [-spec.detune, spec.detune] : [0];
  detunes.forEach((detune, index) => {
    const oscillator = context.createOscillator();
    oscillator.type = spec.type ?? "sine";
    oscillator.frequency.setValueAtTime(spec.frequency, spec.at);
    if (spec.glideTo) oscillator.frequency.exponentialRampToValueAtTime(spec.glideTo, end);
    oscillator.detune.value = detune;
    oscillator.connect(envelope);
    oscillator.start(spec.at);
    oscillator.stop(end + 0.02);
    if (index === 0) oscillator.onended = () => envelope.disconnect();
  });
}

/** Equal-tempered pitch, in semitones above A4. */
const note = (semitones: number) => 440 * Math.pow(2, semitones / 12);

// ---------------------------------------------------------------------------------------------
// Dice impacts
// ---------------------------------------------------------------------------------------------

const hitGate = createHitGate();
/** Roughly how long each impact rings, in ms (used for the voice cap). */
const HIT_RING_MS: Record<Surface, number> = { felt: 110, wood: 80, die: 45 };

/** A die hit the felt, a rail, or another die. `strength` is 0..1 (impact speed, normalised). */
export function playDiceHit(strength: number, surface: "felt" | "wood" | "die"): void {
  safely((output) => {
    const now = output.context.currentTime;
    if (!hitGate.admit(now * 1000, clampStrength(strength), surface, HIT_RING_MS[surface] ?? 80)) return;
    const level = hitGain(strength);
    const at = now + 0.001;
    // Harder hits are brighter as well as louder.
    const brightness = 0.75 + 0.5 * clampStrength(strength);

    if (surface === "felt") {
      // Soft and muffled: a dull thump with a little cloth "pff" on top.
      tone(output, { at, frequency: 150 * vary(0.2), glideTo: 62 * vary(0.1), gain: 0.5 * level, attack: 0.002, decay: 0.07 * vary(0.2) });
      noiseBurst(output, { at, gain: 0.34 * level, decay: 0.05 * vary(0.25), filter: "lowpass", frequency: 780 * brightness * vary(0.25), q: 0.6 });
    } else if (surface === "wood") {
      // Sharper: a hollow knock with a woody body resonance.
      const body = 420 * vary(0.22);
      noiseBurst(output, { at, gain: 0.5 * level, decay: 0.03 * vary(0.2), filter: "bandpass", frequency: 1900 * brightness * vary(0.2), q: 1.6 });
      tone(output, { at, frequency: body, glideTo: body * 0.82, type: "triangle", gain: 0.38 * level, attack: 0.001, decay: 0.055 * vary(0.2) });
      tone(output, { at, frequency: body * 2.63, gain: 0.1 * level, attack: 0.001, decay: 0.025 });
    } else {
      // Die on die: a short, bright, glassy click.
      const ping = 3100 * vary(0.25);
      noiseBurst(output, { at, gain: 0.42 * level, decay: 0.014 * vary(0.2), filter: "bandpass", frequency: 4600 * brightness * vary(0.2), q: 3 });
      tone(output, { at, frequency: ping, type: "triangle", gain: 0.2 * level, attack: 0.0008, decay: 0.022 * vary(0.25) });
      tone(output, { at, frequency: ping * 1.52, gain: 0.07 * level, attack: 0.0008, decay: 0.012 });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------------------------

let lastSelectAt = -Infinity;

/** A die was selected or deselected. */
export function playSelect(selected: boolean): void {
  safely((output) => {
    const now = output.context.currentTime;
    if (now - lastSelectAt < 0.03) return;
    lastSelectAt = now;
    // A light two-note tick: up for select, down for deselect.
    const [first, second] = selected ? [note(7), note(12)] : [note(7), note(2)];
    tone(output, { at: now, frequency: first * vary(0.01), type: "triangle", gain: 0.16, decay: 0.05 });
    tone(output, { at: now + 0.045, frequency: second * vary(0.01), type: "triangle", gain: 0.18, decay: 0.09 });
  });
}

/** Rate-limits a cue so a double call (StrictMode effects, repeated events) plays once. */
function once(gapSeconds: number): (now: number) => boolean {
  let last = -Infinity;
  return (now) => {
    if (now - last < gapSeconds) return false;
    last = now;
    return true;
  };
}

const bankGate = once(0.25);
const farkleGate = once(0.4);
const hotDiceGate = once(0.4);
const winGate = once(1);

/** Points were banked: a warm rising arpeggio with a coin-like shimmer. */
export function playBank(): void {
  safely((output) => {
    const now = output.context.currentTime;
    if (!bankGate(now)) return;
    [3, 7, 10, 15].forEach((semitones, index) => {
      const at = now + index * 0.065;
      tone(output, { at, frequency: note(semitones), type: "triangle", gain: 0.2, decay: 0.22, detune: 4 });
      tone(output, { at, frequency: note(semitones + 24), gain: 0.05, decay: 0.12 });
    });
    noiseBurst(output, { at: now + 0.2, gain: 0.05, decay: 0.18, filter: "highpass", frequency: 6500, q: 0.7 });
  });
}

/** The player farkled: a short, rueful two-step slide down. */
export function playFarkle(): void {
  safely((output) => {
    const now = output.context.currentTime;
    if (!farkleGate(now)) return;
    tone(output, { at: now, frequency: note(-5), glideTo: note(-7), type: "sawtooth", gain: 0.11, attack: 0.01, decay: 0.2, detune: 7 });
    tone(output, { at: now + 0.2, frequency: note(-9), glideTo: note(-17), type: "sawtooth", gain: 0.12, attack: 0.01, decay: 0.42, detune: 9 });
    tone(output, { at: now, frequency: note(-29), glideTo: note(-33), gain: 0.22, attack: 0.01, decay: 0.55 });
  });
}

/** Hot dice: a quick, sparkling run upwards. */
export function playHotDice(): void {
  safely((output) => {
    const now = output.context.currentTime;
    if (!hotDiceGate(now)) return;
    [3, 7, 10, 15, 19, 22].forEach((semitones, index) => {
      const at = now + index * 0.045;
      tone(output, { at, frequency: note(semitones), type: "triangle", gain: 0.16, decay: 0.12 });
      tone(output, { at, frequency: note(semitones + 12), gain: 0.07, decay: 0.09 });
    });
    const top = now + 6 * 0.045;
    tone(output, { at: top, frequency: note(27), type: "triangle", gain: 0.2, decay: 0.4, detune: 5 });
    tone(output, { at: top, frequency: note(39), gain: 0.06, decay: 0.3 });
    noiseBurst(output, { at: top, gain: 0.05, decay: 0.3, filter: "highpass", frequency: 7000, q: 0.7 });
  });
}

/** Game over: a small fanfare ending on a held major chord. */
export function playWin(): void {
  safely((output) => {
    const now = output.context.currentTime;
    if (!winGate(now)) return;
    const melody: Array<[semitones: number, start: number, length: number]> = [
      [3, 0, 0.14],
      [3, 0.15, 0.1],
      [7, 0.27, 0.14],
      [10, 0.42, 0.16],
      [15, 0.6, 0.9],
    ];
    for (const [semitones, start, length] of melody) {
      tone(output, { at: now + start, frequency: note(semitones), type: "triangle", gain: 0.2, attack: 0.008, decay: length + 0.12, detune: 5 });
      tone(output, { at: now + start, frequency: note(semitones - 12), type: "sine", gain: 0.1, attack: 0.008, decay: length + 0.1 });
    }
    // Final chord (C major, in the key the melody implies) with a soft shimmer.
    for (const semitones of [-9, 3, 7, 10, 19]) {
      tone(output, { at: now + 0.6, frequency: note(semitones), type: "sine", gain: 0.085, attack: 0.02, decay: 1.3, detune: 3 });
    }
    noiseBurst(output, { at: now + 0.6, gain: 0.04, decay: 0.6, filter: "highpass", frequency: 6000, q: 0.7 });
  });
}
