import { useId, useState, type SubmitEvent } from "react";
import { ROOM_CODE_LENGTH, roomCodeFromInput } from "../../net/protocol";
import { Screen } from "../setup/Brand";
import "./online.css";

interface JoinScreenProps {
  onJoin: (code: string) => void;
  onBack: () => void;
}

/** Type a game code, or paste the invite link. */
export function JoinScreen({ onJoin, onBack }: JoinScreenProps) {
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const uid = useId();
  const code = roomCodeFromInput(value);
  const error = submitted && code === null ? `Codes are ${ROOM_CODE_LENGTH} letters and numbers, like K7M2PQ` : null;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (code !== null) onJoin(code);
  };

  return (
    <Screen onBack={onBack} compact>
      <form className="setup__card" onSubmit={submit} noValidate aria-labelledby={`${uid}-title`}>
        <h2 id={`${uid}-title`} className="setup__heading">
          Join a game
        </h2>
        <p className="online__lead">Enter the code your friend gave you, or paste their invite link.</p>
        <div className="online__field">
          <label className="setup__legend" htmlFor={`${uid}-code`}>
            Game code
          </label>
          <input
            id={`${uid}-code`}
            className="setup__input online__code-input"
            type="text"
            value={value}
            placeholder="K7M2PQ"
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${uid}-err` : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              setSubmitted(false);
            }}
          />
          {error ? (
            <p id={`${uid}-err`} className="setup__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <button type="submit" className="setup__btn setup__btn--start">
          Join game
        </button>
      </form>
    </Screen>
  );
}
