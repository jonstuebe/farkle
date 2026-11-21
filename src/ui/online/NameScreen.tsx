import { useId, useState, type SubmitEvent } from "react";
import { PLAYER_NAME_MAX_LENGTH, cleanPlayerName } from "../../net/protocol";
import { Screen } from "../setup/Brand";
import "./online.css";

interface NameScreenProps {
  /** The current name when editing; empty the first time. */
  initial?: string;
  /** What happens next, for the button: "Continue", "Save". */
  submitLabel?: string;
  onDone: (name: string) => void;
  onBack: () => void;
}

/** Asks what to call this player in online games. Shown once, and again from "Change name". */
export function NameScreen({ initial = "", submitLabel = "Continue", onDone, onBack }: NameScreenProps) {
  const [value, setValue] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const uid = useId();
  const error = submitted && cleanPlayerName(value) === null ? "Enter a name" : null;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    const name = cleanPlayerName(value);
    if (name !== null) onDone(name);
  };

  return (
    <Screen onBack={onBack} compact>
      <form className="setup__card" onSubmit={submit} noValidate aria-labelledby={`${uid}-title`}>
        <h2 id={`${uid}-title`} className="setup__heading">
          What should we call you?
        </h2>
        <p className="online__lead">Other players see this name at the table. You can change it later.</p>
        <div className="online__field">
          <label className="setup__legend" htmlFor={`${uid}-name`}>
            Your name
          </label>
          <input
            id={`${uid}-name`}
            className="setup__input"
            type="text"
            value={value}
            maxLength={PLAYER_NAME_MAX_LENGTH}
            autoFocus
            autoComplete="given-name"
            autoCapitalize="words"
            spellCheck={false}
            enterKeyHint="done"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${uid}-err` : undefined}
            onChange={(e) => setValue(e.target.value)}
          />
          {error ? (
            <p id={`${uid}-err`} className="setup__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <button type="submit" className="setup__btn setup__btn--start">
          {submitLabel}
        </button>
      </form>
    </Screen>
  );
}
