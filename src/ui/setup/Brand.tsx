import type { ReactNode } from "react";
import "./setup.css";

/** The two-dice logo and "Farkle" title shown at the top of every pre-game screen. */
export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <header className={compact ? "setup__header setup__header--compact" : "setup__header"}>
      <svg className="setup__logo" viewBox="0 0 120 64" aria-hidden="true">
        <g transform="rotate(-12 34 34)">
          <rect x="10" y="10" width="46" height="46" rx="11" fill="var(--ivory)" stroke="var(--gold)" strokeWidth="2" />
          <g fill="var(--ink)">
            <circle cx="33" cy="33" r="5" />
          </g>
        </g>
        <g transform="rotate(10 86 32)">
          <rect x="64" y="8" width="46" height="46" rx="11" fill="var(--ivory)" stroke="var(--gold)" strokeWidth="2" />
          <g fill="var(--ink)">
            <circle cx="76" cy="20" r="4.5" />
            <circle cx="98" cy="20" r="4.5" />
            <circle cx="87" cy="31" r="4.5" />
            <circle cx="76" cy="42" r="4.5" />
            <circle cx="98" cy="42" r="4.5" />
          </g>
        </g>
      </svg>
      <h1 className="setup__title">Farkle</h1>
      {compact ? null : <p className="setup__tagline">Push your luck. Bank it, or lose it all.</p>}
    </header>
  );
}

/** Top-left "back" link used by screens that sit below the home screen. */
export function BackButton({ onClick, label = "Home" }: { onClick: () => void; label?: string }) {
  return (
    <button type="button" className="setup__back" onClick={onClick}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M15 5l-7 7 7 7" />
      </svg>
      {label}
    </button>
  );
}

interface ScreenProps {
  children: ReactNode;
  /** Shows the back link when set. */
  onBack?: () => void;
  backLabel?: string;
  compact?: boolean;
}

/** Page shell shared by the home, naming, join, lobby and setup screens. */
export function Screen({ children, onBack, backLabel, compact }: ScreenProps) {
  return (
    <main className="setup">
      <div className="setup__inner">
        {onBack ? <BackButton onClick={onBack} label={backLabel} /> : null}
        <Brand compact={compact} />
        {children}
      </div>
    </main>
  );
}
