import { useSyncExternalStore } from "react";
import { armAudio, isMuted, setMuted, subscribeMuted } from "./engine";

/** Diameter of the button, in CSS px (also its footprint for anyone laying out around it). */
export const MUTE_BUTTON_SIZE = 40;
/** Gap between the button and the viewport's (safe-area) corner, in CSS px. */
export const MUTE_BUTTON_MARGIN = 10;

const STYLES = `
.mute-button {
  position: fixed;
  top: calc(env(safe-area-inset-top, 0px) + ${MUTE_BUTTON_MARGIN}px);
  right: calc(env(safe-area-inset-right, 0px) + ${MUTE_BUTTON_MARGIN}px);
  z-index: var(--z-top, 40);
  box-sizing: border-box;
  width: ${MUTE_BUTTON_SIZE}px;
  height: ${MUTE_BUTTON_SIZE}px;
  padding: 0;
  display: grid;
  place-items: center;
  border: 1px solid rgba(244, 236, 216, 0.22);
  border-radius: 50%;
  background: rgba(20, 13, 8, 0.62);
  color: #f4ecd8;
  cursor: pointer;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 240, 210, 0.08);
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  transition: background-color 120ms ease, border-color 120ms ease, transform 120ms ease, opacity 120ms ease;
}
/* A bigger invisible hit area for thumbs, without a bigger visual footprint. */
.mute-button::after { content: ""; position: absolute; inset: -4px; border-radius: 50%; }
.mute-button[aria-pressed="true"] { color: rgba(244, 236, 216, 0.6); }
.mute-button:hover { background: rgba(42, 27, 16, 0.82); border-color: rgba(244, 236, 216, 0.4); }
.mute-button:active { transform: scale(0.94); }
.mute-button:focus-visible { outline: 3px solid var(--gold-bright, #f2cf7a); outline-offset: 2px; }
.mute-button svg { display: block; width: 20px; height: 20px; }
@media (prefers-reduced-motion: reduce) { .mute-button { transition: none; } }
`;

/**
 * Floating sound on/off toggle in the top-right corner. Persists in localStorage and drives the
 * master gain. `aria-pressed` is true while sound is muted.
 */
export function MuteButton() {
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
  const label = muted ? "Unmute sound" : "Mute sound";

  return (
    <>
      <style>{STYLES}</style>
      <button
        type="button"
        className="mute-button"
        aria-pressed={muted}
        aria-label={label}
        title={label}
        onPointerDown={armAudio}
        onClick={() => setMuted(!muted)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor" />
          {muted ? (
            <path d="M16 9.5l5 5m0-5l-5 5" />
          ) : (
            <>
              <path d="M15.5 9.2a4 4 0 0 1 0 5.6" />
              <path d="M18 6.6a7.6 7.6 0 0 1 0 10.8" />
            </>
          )}
        </svg>
      </button>
    </>
  );
}
