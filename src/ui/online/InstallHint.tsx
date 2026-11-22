import { useId, useState, useSyncExternalStore } from "react";
import { canPromptInstall, installKind, promptInstall, subscribeInstall, type InstallKind } from "../../net/install";
import "./online.css";

interface Step {
  icon: "share" | "add" | "menu" | "app";
  text: string;
}

const INTRO = "Farkle plays best from your Home Screen: full screen, and it can alert you when it's your turn.";

const STEPS: Record<"ios" | "android", Step[]> = {
  ios: [
    { icon: "share", text: "Tap Share in Safari. If you don't see it, tap ••• first." },
    { icon: "add", text: "Scroll down, tap Add to Home Screen, then Add." },
    { icon: "app", text: "Open Farkle from your Home Screen." },
  ],
  android: [
    { icon: "menu", text: "Tap the ⋮ menu in Chrome." },
    { icon: "add", text: "Tap Add to Home screen or Install app, then Install." },
    { icon: "app", text: "Open Farkle from your Home Screen." },
  ],
};

// On iPhone the Home Screen app has its own storage, apart from Safari's.
const NOTE: Record<"ios" | "android", string> = {
  ios: "The app starts fresh: games you began in Safari stay in Safari. To get back into an online game there, use Join with a code.",
  android: "An invite link may still open in Chrome. To join a friend in the app, use Join with a code.",
};

function StepIcon({ icon }: { icon: Step["icon"] }) {
  switch (icon) {
    case "share":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v12M8 7l4-4 4 4M6 11H5v10h14V11h-1" />
        </svg>
      );
    case "add":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="4" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case "menu":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="5" r="1.5" />
          <circle cx="12" cy="12" r="1.5" />
          <circle cx="12" cy="19" r="1.5" />
        </svg>
      );
    case "app":
      return <img src="/icon-192.png" alt="" width={24} height={24} />;
  }
}

/**
 * "Add Farkle to your Home Screen", on phones that are playing in the browser. Collapsed to a
 * link until tapped; Android with Chrome's install prompt gets a real Install button.
 */
export function InstallHint({ open: openProp, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [kind] = useState<InstallKind>(() => installKind());
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const canPrompt = useSyncExternalStore(subscribeInstall, canPromptInstall);
  const uid = useId();

  if (kind !== "ios" && kind !== "android") return null;

  if (!open) {
    return (
      <button
        type="button"
        className="online__link online__install-link"
        onClick={() => {
          if (canPrompt) void promptInstall();
          else setOpen(true);
        }}
      >
        <StepIcon icon="add" /> Add Farkle to your Home Screen
      </button>
    );
  }

  return (
    <section className="setup__card online__install" aria-labelledby={`${uid}-install`}>
      <h2 id={`${uid}-install`} className="setup__heading">
        Add to Home Screen
      </h2>
      <p className="online__lead">{INTRO}</p>
      {kind === "android" && canPrompt ? (
        <button type="button" className="setup__btn setup__btn--primary" onClick={() => void promptInstall()}>
          Install Farkle
        </button>
      ) : (
        <ol className="online__install-steps">
          {STEPS[kind].map((step) => (
            <li key={step.text}>
              <span className="online__install-icon">
                <StepIcon icon={step.icon} />
              </span>
              {step.text}
            </li>
          ))}
        </ol>
      )}
      <p className="setup__meta">{NOTE[kind]}</p>
      <button type="button" className="setup__btn setup__btn--ghost" onClick={() => setOpen(false)}>
        Not now
      </button>
    </section>
  );
}
