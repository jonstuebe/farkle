import { useCallback, useEffect, useRef, useState } from "react";
import { playBank, playFarkle, playHotDice, playWin } from "../../audio/sfx";
import type { useGameActor } from "../../game/react";
import {
  burstFeedback,
  diffFeedback,
  isYou,
  turnCue,
  viewOf,
  type Banner,
  type Feedback,
  type HudView,
  type SoundKind,
  type Table,
} from "./logic";

/** How long a banner stays up; matches the `fk-banner` animation in hud.css. */
const BANNER_MS = 2800;
const MAX_VISIBLE = 3;
/** The same turn cue can be reached two ways at once (replay ended as the turn changed). */
const CUE_REPEAT_MS = 1500;

const SOUNDS: Record<SoundKind, () => void> = {
  farkle: playFarkle,
  hotDice: playHotDice,
  bank: playBank,
  win: playWin,
};

export interface ShownBanner extends Banner {
  id: number;
}

export interface BannerOptions {
  table: Table;
  /** The presenter is replaying moves this device missed. */
  replaying: boolean;
  /** Bumped when the presenter jumps to the latest state (replay skipped). */
  snapCount: number;
}

/**
 * Watches the presented game and turns state changes into short-lived banners and sounds. It
 * makes no difference who moved or whether the move is live or replayed: both arrive as changes
 * to the same actor.
 */
export function useBanners(
  actor: ReturnType<typeof useGameActor>,
  { table, replaying, snapCount }: BannerOptions,
): ShownBanner[] {
  const [banners, setBanners] = useState<ShownBanner[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const lastCue = useRef({ text: "", at: 0 });
  const live = useRef({ table, replaying });
  live.current = { table, replaying };

  const show = useCallback((incoming: Banner[]) => {
    const fresh = incoming.filter((banner) => {
      if (banner.kind !== "turn") return true;
      const now = Date.now();
      const repeat = lastCue.current.text === banner.text && now - lastCue.current.at < CUE_REPEAT_MS;
      if (!repeat) lastCue.current = { text: banner.text, at: now };
      return !repeat;
    });
    if (fresh.length === 0) return;
    const shown = fresh.map((banner) => ({ ...banner, id: nextId.current++ }));
    setBanners((current) => [...current, ...shown].slice(-MAX_VISIBLE));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setBanners((current) => current.filter((b) => !shown.some((s) => s.id === b.id)));
    }, BANNER_MS);
    timers.current.add(timer);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    let prev = viewOf(actor.getSnapshot());
    // Views reached since the last flush. Changes are announced one microtask late so that a
    // run of moves applied in one go (a skipped replay, or a batch after reconnecting) is seen
    // as a whole: the presenter only bumps `snapCount` after it has fed every entry.
    let queue: HudView[] = [];
    let cancelled = false;

    const flush = () => {
      if (cancelled || queue.length === 0) return;
      const first = prev;
      const steps = queue;
      const last = steps[steps.length - 1]!;
      queue = [];
      prev = last;

      let feedback: Feedback;
      if (steps.length === 1) {
        feedback = diffFeedback(first, last);
        // Online, play reaching my seat deserves a nudge. (After a replay the cue comes from
        // the effect below instead.)
        const { table: seats, replaying: catchingUp } = live.current;
        const mine = isYou(seats, last.context.current) && first.context.current !== last.context.current;
        const cue = mine && !catchingUp ? turnCue(last, seats) : null;
        if (cue) feedback = { ...feedback, banners: [...feedback.banners, cue] };
      } else {
        feedback = burstFeedback(first, last);
      }
      for (const sound of feedback.sounds) SOUNDS[sound]();
      show(feedback.banners);
    };

    const subscription = actor.subscribe((snapshot) => {
      if (queue.length === 0) queueMicrotask(flush);
      queue.push(viewOf(snapshot));
    });
    return () => {
      cancelled = true;
      subscription.unsubscribe();
      setBanners([]);
    };
  }, [actor, show]);

  // A skip leaves banners from the replayed moves on screen: drop them, they are old news.
  const seenSnap = useRef(snapCount);
  useEffect(() => {
    if (seenSnap.current === snapCount) return;
    seenSnap.current = snapCount;
    setBanners((current) => current.filter((banner) => banner.kind === "turn"));
  }, [snapCount]);

  // Replay over (watched or skipped): say whose turn it is now.
  const wasReplaying = useRef(replaying);
  useEffect(() => {
    if (wasReplaying.current === replaying) return;
    wasReplaying.current = replaying;
    if (replaying) return;
    const cue = turnCue(viewOf(actor.getSnapshot()), live.current.table);
    if (cue) show([cue]);
  }, [replaying, actor, show]);

  return banners;
}

export interface BannersProps {
  banners: ShownBanner[];
  /** Online and the connection dropped: stays up until it is back. */
  reconnecting: boolean;
}

export function Banners({ banners, reconnecting }: BannersProps) {
  return (
    <div className="fk-banners" role="status" aria-live="polite">
      {reconnecting && (
        <div className="fk-net">
          <span className="fk-net__spinner" aria-hidden="true" />
          Reconnecting…
        </div>
      )}
      {banners.map((banner) => (
        <div key={banner.id} className={`fk-banner fk-banner--${banner.kind}`}>
          {banner.text}
        </div>
      ))}
    </div>
  );
}
