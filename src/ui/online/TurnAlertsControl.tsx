import { useEffect, useId, useSyncExternalStore } from "react";
import { turnAlerts, type AlertState } from "../../net/turnAlerts";
import "./online.css";

interface TurnAlertsControlProps {
  deviceId: string;
  /** iOS Safari: alerts need the Home Screen app; this opens the steps. */
  onShowInstall?: () => void;
}

const BELL = (
  <svg viewBox="0 0 24 24" aria-hidden="true" className="online__alerts-icon">
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </svg>
);

/** The line under the switch. */
export function alertsNote({ status, problem }: AlertState): string {
  if (problem === "failed") {
    return status === "on" ? "Alerts are on, but some games couldn't be reached. They'll be tried again." : "Couldn't turn on alerts. Try again.";
  }
  if (problem === "dismissed") return "Allow notifications when your browser asks, and you'll get an alert on your turn.";
  switch (status) {
    case "on":
      return "You'll get an alert when it's your turn in an online game.";
    case "off":
      return "Get an alert when it's your turn, even with Farkle closed.";
    case "blocked":
      return "Notifications are blocked for Farkle. Allow them in your browser's site settings, then come back.";
    case "unsupported":
      return "This browser can't send turn alerts.";
    case "needsHomeScreen":
      return "On iPhone and iPad, turn alerts work once Farkle is on your Home Screen.";
    case "turningOn":
      return "Turning on…";
    case "turningOff":
      return "Turning off…";
  }
}

const LABEL: Record<AlertState["status"], string> = {
  on: "On",
  off: "Off",
  turningOn: "On",
  turningOff: "Off",
  blocked: "Blocked",
  unsupported: "Unsupported",
  needsHomeScreen: "Add to Home Screen first",
};

/** "Turn alerts" switch for the home screen and the lobby. */
export function TurnAlertsControl({ deviceId, onShowInstall }: TurnAlertsControlProps) {
  const alerts = turnAlerts(deviceId);
  const state = useSyncExternalStore(alerts.subscribe, alerts.getState);
  const { status } = state;
  const noteId = useId();

  // Permission can change in settings while the app is away.
  useEffect(() => {
    void alerts.sync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void alerts.sync();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [alerts]);

  const isSwitch = status === "on" || status === "off" || status === "turningOn" || status === "turningOff";
  const busy = status === "turningOn" || status === "turningOff";

  return (
    <div className="online__alerts" data-status={status}>
      {isSwitch ? (
        <label className="setup__toggle online__alerts-toggle">
          <input
            type="checkbox"
            role="switch"
            className="visually-hidden"
            checked={status === "on" || status === "turningOn"}
            disabled={busy}
            aria-describedby={noteId}
            onChange={(e) => {
              // Straight from the tap: iOS only shows the permission prompt during one.
              if (e.target.checked) void alerts.turnOn();
              else void alerts.turnOff();
            }}
          />
          <span className="setup__switch" aria-hidden="true" />
          <span className="setup__toggle-text">
            <span className="setup__toggle-title">
              {BELL} Turn alerts <span className="online__alerts-state">{busy ? "…" : LABEL[status]}</span>
            </span>
            <span id={noteId} className="setup__meta" role="status" aria-live="polite">
              {alertsNote(state)}
            </span>
          </span>
        </label>
      ) : (
        <div className="online__alerts-fixed">
          <span className="setup__toggle-title">
            {BELL} Turn alerts <span className="online__alerts-state">{LABEL[status]}</span>
          </span>
          <span className="setup__meta">{alertsNote(state)}</span>
          {status === "needsHomeScreen" && onShowInstall ? (
            <button type="button" className="online__link online__alerts-action" onClick={onShowInstall}>
              How to add it
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
