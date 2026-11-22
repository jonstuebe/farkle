import { useLayoutEffect, useRef, useState } from "react";
import {
  dismissTip,
  dismissedTips,
  formatPoints,
  keepChipLabel,
  KEEP_STRIP_WIDTH,
  keepStrip,
  splitComboFace,
  splitComboTip,
  type HudView,
  type TipId,
} from "./logic";

/**
 * What the turn is made of: one chip per keep (combos never span keeps, so this is where
 * "three 5s from three rolls = 150" becomes visible), then the current pick as a dashed chip.
 */
export function KeepStrip({ view }: { view: HudView }) {
  const ref = useRef<HTMLOListElement>(null);
  const [width, setWidth] = useState(KEEP_STRIP_WIDTH);
  const strip = keepStrip(view, width);
  const shown = strip.chips.length > 0;

  // Fold old keeps by the room actually there (wider on desktop than on a phone).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(Math.max(120, el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);

  if (!shown) return null;
  return (
    <ol ref={ref} className="fk-keeps" aria-label="Kept this turn">
      {strip.hidden > 0 && (
        <li
          className="fk-keep fk-keep--more"
          aria-label={`${strip.hidden} earlier ${strip.hidden === 1 ? "keep" : "keeps"} for ${formatPoints(
            strip.hiddenPoints,
          )} points`}
          title={`${strip.hidden} earlier, ${formatPoints(strip.hiddenPoints)} points`}
        >
          +{strip.hidden}
        </li>
      )}
      {strip.chips.map((chip, i) => (
        <li
          key={`${strip.hidden + i}-${chip.pending ? "p" : "k"}`}
          className={`fk-keep${chip.pending ? " fk-keep--pending" : ""}${chip.hotDice ? " fk-keep--hot" : ""}`}
          aria-label={keepChipLabel(chip)}
        >
          <span className="fk-keep__faces" aria-hidden="true">
            {chip.faces.map((face, n) => (
              <span key={n} className="fk-keep__face">
                {face}
              </span>
            ))}
          </span>
          <span className="fk-keep__points" aria-hidden="true">
            {chip.pending ? "+" : ""}
            {formatPoints(chip.points)}
          </span>
          {chip.hotDice && (
            <span className="fk-keep__hot" aria-hidden="true">
              🔥
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

const TIP: TipId = "combosPerRoll";

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** "Combos only count within a single roll", shown until the player dismisses it once. */
export function ComboTip({ view, active }: { view: HudView; active: boolean }) {
  const [dismissed, setDismissed] = useState(() => dismissedTips(storage()).includes(TIP));
  if (dismissed || !active || splitComboFace(view) === null) return null;
  const close = () => {
    dismissTip(storage(), TIP);
    setDismissed(true);
  };
  return (
    <div className="fk-panel fk-tip" role="note" aria-label="Tip">
      <span className="fk-tip__icon" aria-hidden="true">
        💡
      </span>
      <p className="fk-tip__text">{splitComboTip(view.context.rules.scoring)}</p>
      <button type="button" className="fk-chip-button fk-tip__close" onClick={close}>
        Got it
      </button>
    </div>
  );
}
