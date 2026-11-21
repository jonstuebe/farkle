import { useEffect, useRef, useState } from "react";
import { playBank, playFarkle, playHotDice, playWin } from "../../audio/sfx";
import type { useGameActor } from "../../game/react";
import { diffFeedback, viewOf, type Banner, type SoundKind } from "./logic";

/** How long a banner stays up; matches the `fk-banner` animation in hud.css. */
const BANNER_MS = 2800;
const MAX_VISIBLE = 3;

const SOUNDS: Record<SoundKind, () => void> = {
  farkle: playFarkle,
  hotDice: playHotDice,
  bank: playBank,
  win: playWin,
};

export interface ShownBanner extends Banner {
  id: number;
}

/** Watches the game actor and turns state changes into short-lived banners and sounds. */
export function useBanners(actor: ReturnType<typeof useGameActor>): ShownBanner[] {
  const [banners, setBanners] = useState<ShownBanner[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    let prev = viewOf(actor.getSnapshot());
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const subscription = actor.subscribe((snapshot) => {
      const next = viewOf(snapshot);
      const feedback = diffFeedback(prev, next);
      prev = next;
      for (const sound of feedback.sounds) SOUNDS[sound]();
      if (feedback.banners.length === 0) return;
      const shown = feedback.banners.map((banner) => ({ ...banner, id: nextId.current++ }));
      setBanners((current) => [...current, ...shown].slice(-MAX_VISIBLE));
      const timer = setTimeout(() => {
        timers.delete(timer);
        setBanners((current) => current.filter((b) => !shown.some((s) => s.id === b.id)));
      }, BANNER_MS);
      timers.add(timer);
    });
    return () => {
      subscription.unsubscribe();
      for (const timer of timers) clearTimeout(timer);
      setBanners([]);
    };
  }, [actor]);

  return banners;
}

export function Banners({ banners }: { banners: ShownBanner[] }) {
  return (
    <div className="fk-banners" role="status" aria-live="polite">
      {banners.map((banner) => (
        <div key={banner.id} className={`fk-banner fk-banner--${banner.kind}`}>
          {banner.text}
        </div>
      ))}
    </div>
  );
}
