import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useReactions } from "../../game/react";
import { REACTIONS, REACTION_COOLDOWN_MS, REACTION_EMOJI, REACTION_LABEL, type Reaction } from "../../net/protocol";
import { floatAnchor } from "./logic";

/** How long a floating reaction stays up; matches `fk-float` in hud.css. */
const FLOAT_MS = 2200;
const MAX_FLOATS = 12;

export interface FloatingReaction {
  id: number;
  seat: number;
  reaction: Reaction;
  /** Who sent it, for the screen-reader announcement. */
  name: string;
}

export interface ReactionsState {
  /** Null in a local game (and online before a seat is known). */
  send: ((reaction: Reaction) => void) | null;
  /** Until when sending is on cooldown (ms since epoch); 0 when free. */
  coolUntil: number;
  floats: FloatingReaction[];
}

/**
 * Incoming reactions and my own sent ones, as short-lived floats. The server never echoes my
 * own, so they are shown the moment I send. A client-side cooldown matches the server's, which
 * would drop faster ones silently.
 */
export function useReactionFloats(mySeat: number | null, names: readonly string[]): ReactionsState {
  const [floats, setFloats] = useState<FloatingReaction[]>([]);
  const [coolUntil, setCoolUntil] = useState(0);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const namesRef = useRef(names);
  namesRef.current = names;

  const add = useCallback((seat: number, reaction: Reaction, name?: string) => {
    const shown: FloatingReaction = {
      id: nextId.current++,
      seat,
      reaction,
      name: name ?? namesRef.current[seat] ?? "Someone",
    };
    setFloats((current) => [...current, shown].slice(-MAX_FLOATS));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFloats((current) => current.filter((f) => f.id !== shown.id));
    }, FLOAT_MS);
    timers.current.add(timer);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const { send: sendRaw } = useReactions((seat, reaction) => add(seat, reaction));

  const lastSent = useRef(0);
  const send = useCallback(
    (reaction: Reaction) => {
      if (!sendRaw || mySeat === null) return;
      const now = Date.now();
      if (now - lastSent.current < REACTION_COOLDOWN_MS) return;
      lastSent.current = now;
      sendRaw(reaction);
      add(mySeat, reaction, "You");
      setCoolUntil(now + REACTION_COOLDOWN_MS);
    },
    [sendRaw, mySeat, add],
  );

  // Clear the cooldown flag so the picker re-enables.
  useEffect(() => {
    if (coolUntil === 0) return;
    const timer = setTimeout(() => setCoolUntil(0), Math.max(0, coolUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [coolUntil]);

  return { send: sendRaw && mySeat !== null ? send : null, coolUntil, floats };
}

export interface ReactionButtonProps {
  send: (reaction: Reaction) => void;
  cooling: boolean;
}

/** Compact emoji button for the scoreboard; opens the eight reactions. */
export function ReactionButton({ send, cooling }: ReactionButtonProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    rootRef.current?.querySelector<HTMLButtonElement>(".fk-react__pick")?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <div className="fk-react" ref={rootRef}>
      <button
        ref={toggleRef}
        type="button"
        className="fk-chip-button fk-react__toggle"
        aria-label="Send a reaction"
        aria-expanded={open}
        aria-controls="fk-react-menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">😀</span>
      </button>
      {open && (
        <div id="fk-react-menu" className="fk-panel fk-react__menu" role="group" aria-label="Reactions">
          {REACTIONS.map((reaction) => (
            <button
              key={reaction}
              type="button"
              className="fk-react__pick"
              aria-label={REACTION_LABEL[reaction]}
              title={REACTION_LABEL[reaction]}
              aria-disabled={cooling}
              onClick={() => {
                if (cooling) return;
                send(reaction);
                setOpen(false);
                toggleRef.current?.focus();
              }}
            >
              <span aria-hidden="true">{REACTION_EMOJI[reaction]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Placed extends FloatingReaction {
  x: number;
  y: number;
  /** Small horizontal jitter so a burst doesn't stack on one spot. */
  dx: number;
}

/**
 * Floats each reaction up from its sender's scoreboard chip (`[data-seat]`), clamped to the
 * visible part of the strip when the chip is scrolled out of view on a phone.
 */
export function ReactionFloats({ floats }: { floats: FloatingReaction[] }) {
  const [placed, setPlaced] = useState<Placed[]>([]);
  const positions = useRef(new Map<number, { x: number; y: number; dx: number }>());

  useLayoutEffect(() => {
    const known = positions.current;
    for (const f of floats) {
      if (known.has(f.id)) continue;
      const chip = document.querySelector(`.fk-hud [data-seat="${f.seat}"]`);
      const strip = chip?.closest(".fk-players") ?? null;
      if (!chip || !strip) {
        known.set(f.id, { x: window.innerWidth / 2, y: 80, dx: 0 });
        continue;
      }
      const at = floatAnchor(chip.getBoundingClientRect(), strip.getBoundingClientRect());
      known.set(f.id, { ...at, dx: ((f.id * 37) % 21) - 10 });
    }
    for (const id of [...known.keys()]) if (!floats.some((f) => f.id === id)) known.delete(id);
    setPlaced(floats.map((f) => ({ ...f, ...known.get(f.id)! })));
  }, [floats]);

  const latest = floats[floats.length - 1];
  return (
    <>
      <div className="fk-floats" aria-hidden="true">
        {placed.map((f) => (
          <span
            key={f.id}
            className="fk-float"
            style={{ left: f.x + f.dx, top: f.y, ["--fk-float-dx" as string]: `${f.dx}px` }}
          >
            {REACTION_EMOJI[f.reaction]}
          </span>
        ))}
      </div>
      <div className="fk-sr" role="status" aria-live="polite">
        {latest ? `${latest.name}: ${REACTION_LABEL[latest.reaction]}` : ""}
      </div>
    </>
  );
}
