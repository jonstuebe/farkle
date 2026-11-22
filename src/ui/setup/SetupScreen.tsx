import { useEffect, useId, useMemo, useRef, useState, type SubmitEvent } from "react";
import type { GameInput } from "../../game/machine";
import { MAX_BOTS, botNames } from "../../game/bot";
import {
  BOT_PREFS_KEY,
  MAX_NAME_LENGTH,
  MAX_PLAYERS,
  PREFS_KEY,
  MAX_TARGET_SCORE,
  MIN_TARGET_SCORE,
  loadSetupPrefs,
  saveSetupPrefs,
  type SavedGameSummary,
} from "../../game/persistence";
import { Screen } from "./Brand";
import "./setup.css";

export interface SetupScreenProps {
  /** Pass-and-play (a roster of names) or against bots (the person's name and a bot count). */
  mode?: "local" | "bots";
  /** Against bots: the online name, used for the person's seat until they pick another. */
  onlineName?: string | null;
  onStart: (input: GameInput) => void;
  /** An in-progress game found in storage; shows the "Resume game" card when set. */
  savedGame?: SavedGameSummary | null;
  onResume?: () => void;
  /** Shows a "Home" link above the title when set. */
  onBack?: () => void;
}

const TARGET_PRESETS = [5000, 10_000] as const;
const ENTRY_THRESHOLD = 500;

interface PlayerRow {
  /** Stable key so inputs keep focus when rows are added or removed. */
  id: number;
  name: string;
}

const formatScore = (n: number) => n.toLocaleString("en-US");

/** First "Player N" not already taken. */
function nextDefaultName(names: readonly string[]): string {
  const taken = new Set(names.map((n) => n.trim().toLowerCase()));
  for (let n = 1; n <= MAX_PLAYERS + 1; n++) {
    const candidate = `Player ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return "Player";
}

/** Per-row error message (or null), in row order. */
export function validateNames(names: readonly string[]): (string | null)[] {
  const keys = names.map((n) => n.trim().toLowerCase());
  return keys.map((key, i) => {
    if (key.length === 0) return "Enter a name";
    if (keys.indexOf(key) !== i) return "Name already used";
    return null;
  });
}

export function validateTarget(raw: string): string | null {
  if (!/^\d+$/.test(raw.trim())) return "Enter a whole number";
  const value = Number(raw);
  if (value < MIN_TARGET_SCORE) return `At least ${formatScore(MIN_TARGET_SCORE)}`;
  if (value > MAX_TARGET_SCORE) return `At most ${formatScore(MAX_TARGET_SCORE)}`;
  return null;
}

const BOT_COUNTS = Array.from({ length: MAX_BOTS }, (_, i) => i + 1);
/** The name the person's seat gets against bots until they choose one. */
const DEFAULT_BOT_OPPONENT_NAME = "You";

/** Pre-game screen: roster (or name and bots), target score, entry threshold, and resume of a saved game. */
export function SetupScreen({ mode = "local", onlineName = null, onStart, savedGame, onResume, onBack }: SetupScreenProps) {
  const vsBots = mode === "bots";
  const prefsKey = vsBots ? BOT_PREFS_KEY : PREFS_KEY;
  const prefs = useMemo(() => {
    const loaded = loadSetupPrefs(undefined, prefsKey);
    if (!vsBots) return loaded;
    // Against bots the roster is just the person: their saved name, else their online name.
    const saved = loaded.players[0];
    const name = saved && saved !== DEFAULT_BOT_OPPONENT_NAME ? saved : (onlineName ?? DEFAULT_BOT_OPPONENT_NAME);
    return { ...loaded, players: [name.slice(0, MAX_NAME_LENGTH)] };
  }, [prefsKey, vsBots, onlineName]);
  const nextId = useRef(prefs.players.length);
  const [players, setPlayers] = useState<PlayerRow[]>(() => prefs.players.map((name, id) => ({ id, name })));
  const [botCount, setBotCount] = useState(prefs.bots ?? 1);
  const isPreset = (TARGET_PRESETS as readonly number[]).includes(prefs.targetScore);
  const [targetMode, setTargetMode] = useState<"preset" | "custom">(isPreset ? "preset" : "custom");
  const [preset, setPreset] = useState<number>(isPreset ? prefs.targetScore : 10_000);
  const [customTarget, setCustomTarget] = useState(isPreset ? "" : String(prefs.targetScore));
  const [entryOn, setEntryOn] = useState(prefs.entryThreshold > 0);
  const [submitted, setSubmitted] = useState(false);
  const [focusRow, setFocusRow] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const uid = useId();
  const rowRefs = useRef(new Map<number, HTMLInputElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const customRef = useRef<HTMLInputElement>(null);

  const names = players.map((p) => p.name);
  const nameErrors = validateNames(names);
  const targetError = targetMode === "custom" ? validateTarget(customTarget) : null;
  // Duplicates are shown as you type; "empty" only after a start attempt.
  const shownNameErrors = nameErrors.map((e) => (e === "Enter a name" && !submitted ? null : e));
  const shownTargetError = submitted || customTarget.trim() !== "" ? targetError : null;
  const errorCount = nameErrors.filter(Boolean).length + (targetError ? 1 : 0);

  // Move focus after add/remove once the row exists (or is gone).
  useEffect(() => {
    if (focusRow === null) return;
    const el = rowRefs.current.get(focusRow);
    if (el) {
      el.focus();
      el.select();
    } else {
      addRef.current?.focus();
    }
    setFocusRow(null);
  }, [focusRow]);

  const addPlayer = () => {
    if (players.length >= MAX_PLAYERS) return;
    const id = nextId.current++;
    const name = nextDefaultName(names);
    setPlayers([...players, { id, name }]);
    setFocusRow(id);
    setAnnouncement(`${name} added. ${players.length + 1} players.`);
  };

  const removePlayer = (id: number) => {
    if (players.length <= 1) return;
    const index = players.findIndex((p) => p.id === id);
    const rest = players.filter((p) => p.id !== id);
    setPlayers(rest);
    setFocusRow((rest[index] ?? rest[index - 1])?.id ?? null);
    setAnnouncement(`${players[index]?.name.trim() || "Player"} removed. ${rest.length} player${rest.length === 1 ? "" : "s"}.`);
  };

  const rename = (id: number, name: string) =>
    setPlayers(players.map((p) => (p.id === id ? { ...p, name: name.slice(0, MAX_NAME_LENGTH) } : p)));

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    const badRow = nameErrors.findIndex(Boolean);
    if (badRow !== -1) {
      rowRefs.current.get(players[badRow]!.id)?.focus();
      setAnnouncement(`Player ${badRow + 1}: ${nameErrors[badRow]}`);
      return;
    }
    if (targetError) {
      customRef.current?.focus();
      setAnnouncement(`Target score: ${targetError}`);
      return;
    }
    const roster = names.map((n) => n.trim());
    const targetScore = targetMode === "custom" ? Number(customTarget) : preset;
    const entryThreshold = entryOn ? ENTRY_THRESHOLD : 0;
    if (vsBots) {
      saveSetupPrefs({ players: roster, targetScore, entryThreshold, bots: botCount }, undefined, prefsKey);
      // The person always rolls first; the bots take the seats after them.
      const bots = botNames(botCount, roster);
      onStart({
        players: [...roster, ...bots],
        rules: { targetScore, entryThreshold },
        bots: bots.map((_, i) => roster.length + i),
      });
      return;
    }
    saveSetupPrefs({ players: roster, targetScore, entryThreshold }, undefined, prefsKey);
    onStart({ players: roster, rules: { targetScore, entryThreshold } });
  };

  const leader = savedGame ? Math.max(...savedGame.players.map((p) => p.score)) : 0;

  return (
    <Screen onBack={onBack} compact={Boolean(onBack)}>
        {savedGame && onResume ? (
          <section className="setup__card setup__resume" aria-labelledby={`${uid}-resume`}>
            <div className="setup__resume-head">
              <h2 id={`${uid}-resume`} className="setup__heading">
                Game in progress
              </h2>
              <span className="setup__meta">
                {savedGame.finalRound ? "Final round · " : ""}to {formatScore(savedGame.targetScore)}
              </span>
            </div>
            <ul className="setup__scores">
              {savedGame.players.map((p, i) => (
                <li key={i} className={i === savedGame.current ? "setup__score is-current" : "setup__score"}>
                  <span className="setup__score-name">
                    {p.name}
                    {i === savedGame.current ? <span className="setup__turn"> · to roll</span> : null}
                  </span>
                  <span className={p.score === leader && leader > 0 ? "setup__score-value is-leader" : "setup__score-value"}>
                    {formatScore(p.score)}
                  </span>
                </li>
              ))}
            </ul>
            <button type="button" className="setup__btn setup__btn--primary" onClick={onResume}>
              Resume game
            </button>
          </section>
        ) : null}

        <form className="setup__card" onSubmit={submit} noValidate aria-labelledby={`${uid}-new`}>
          <h2 id={`${uid}-new`} className="setup__heading">
            {savedGame ? "Or start a new game" : vsBots ? "New game against bots" : "New game"}
          </h2>

          {vsBots ? (
            <BotFields
              uid={uid}
              row={players[0]!}
              error={shownNameErrors[0] ?? null}
              inputRef={(el) => {
                const id = players[0]!.id;
                if (el) rowRefs.current.set(id, el);
                else rowRefs.current.delete(id);
              }}
              onRename={(name) => rename(players[0]!.id, name)}
              botCount={botCount}
              onBotCount={setBotCount}
            />
          ) : (
            <fieldset className="setup__group">
              <legend className="setup__legend">
                Players <span className="setup__meta">{players.length} of {MAX_PLAYERS}</span>
              </legend>
              <ol className="setup__players">
                {players.map((p, i) => {
                  const error = shownNameErrors[i];
                  const errorId = `${uid}-err-${p.id}`;
                  return (
                    <li key={p.id} className="setup__player">
                      <span className="setup__seat" aria-hidden="true">
                        {i + 1}
                      </span>
                      <input
                        ref={(el) => {
                          if (el) rowRefs.current.set(p.id, el);
                          else rowRefs.current.delete(p.id);
                        }}
                        className="setup__input"
                        type="text"
                        value={p.name}
                        maxLength={MAX_NAME_LENGTH}
                        placeholder={`Player ${i + 1}`}
                        aria-label={`Player ${i + 1} name`}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={error ? errorId : undefined}
                        autoComplete="off"
                        autoCapitalize="words"
                        spellCheck={false}
                        enterKeyHint="done"
                        onChange={(e) => rename(p.id, e.target.value)}
                        onFocus={(e) => e.target.select()}
                      />
                      <button
                        type="button"
                        className="setup__icon-btn"
                        onClick={() => removePlayer(p.id)}
                        disabled={players.length <= 1}
                        aria-label={`Remove ${p.name.trim() || `player ${i + 1}`}`}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                      {error ? (
                        <p id={errorId} className="setup__error">
                          {error}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              <button
                ref={addRef}
                type="button"
                className="setup__btn setup__btn--ghost"
                onClick={addPlayer}
                disabled={players.length >= MAX_PLAYERS}
              >
                {players.length >= MAX_PLAYERS ? `${MAX_PLAYERS} players max` : "+ Add player"}
              </button>
            </fieldset>
          )}

          <fieldset className="setup__group">
            <legend className="setup__legend">Play to</legend>
            <div className="setup__segments">
              {TARGET_PRESETS.map((value) => (
                <label key={value} className="setup__segment">
                  <input
                    type="radio"
                    name={`${uid}-target`}
                    className="visually-hidden"
                    checked={targetMode === "preset" && preset === value}
                    onChange={() => {
                      setTargetMode("preset");
                      setPreset(value);
                    }}
                  />
                  <span>{formatScore(value)}</span>
                </label>
              ))}
              <label className="setup__segment">
                <input
                  type="radio"
                  name={`${uid}-target`}
                  className="visually-hidden"
                  checked={targetMode === "custom"}
                  onChange={() => setTargetMode("custom")}
                />
                <span>Custom</span>
              </label>
            </div>
            {targetMode === "custom" ? (
              <div className="setup__custom">
                <input
                  ref={customRef}
                  className="setup__input"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  value={customTarget}
                  placeholder="e.g. 7500"
                  aria-label="Custom target score"
                  aria-invalid={shownTargetError ? true : undefined}
                  aria-describedby={shownTargetError ? `${uid}-target-err` : undefined}
                  autoComplete="off"
                  onChange={(e) => setCustomTarget(e.target.value.replace(/[^\d]/g, ""))}
                />
                {shownTargetError ? (
                  <p id={`${uid}-target-err`} className="setup__error">
                    {shownTargetError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </fieldset>

          <label className="setup__toggle">
            <input
              type="checkbox"
              role="switch"
              className="visually-hidden"
              checked={entryOn}
              onChange={(e) => setEntryOn(e.target.checked)}
            />
            <span className="setup__switch" aria-hidden="true" />
            <span className="setup__toggle-text">
              <span className="setup__toggle-title">{formatScore(ENTRY_THRESHOLD)} to get on the board</span>
              <span className="setup__meta">Your first banked turn must score at least {formatScore(ENTRY_THRESHOLD)}</span>
            </span>
          </label>

          <button type="submit" className="setup__btn setup__btn--start" aria-disabled={errorCount > 0 ? true : undefined}>
            Start game
          </button>
        </form>

        <p className="visually-hidden" role="status" aria-live="polite">
          {announcement}
        </p>
    </Screen>
  );
}

interface BotFieldsProps {
  uid: string;
  row: PlayerRow;
  error: string | null;
  inputRef: (el: HTMLInputElement | null) => void;
  onRename: (name: string) => void;
  botCount: number;
  onBotCount: (count: number) => void;
}

/** Against bots: the person's name and how many bots to play. */
function BotFields({ uid, row, error, inputRef, onRename, botCount, onBotCount }: BotFieldsProps) {
  const opponents = botNames(botCount, [row.name]);
  return (
    <>
      <fieldset className="setup__group">
        <legend className="setup__legend">Your name</legend>
        <div className="setup__custom">
          <input
            ref={inputRef}
            className="setup__input"
            type="text"
            value={row.name}
            maxLength={MAX_NAME_LENGTH}
            placeholder={DEFAULT_BOT_OPPONENT_NAME}
            aria-label="Your name"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${uid}-name-err` : undefined}
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            enterKeyHint="done"
            onChange={(e) => onRename(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
          {error ? (
            <p id={`${uid}-name-err`} className="setup__error">
              {error}
            </p>
          ) : null}
        </div>
      </fieldset>

      <fieldset className="setup__group">
        <legend className="setup__legend">
          Bots <span className="setup__meta">{botCount + 1} players in all</span>
        </legend>
        <div className="setup__segments setup__segments--bots">
          {BOT_COUNTS.map((count) => (
            <label key={count} className="setup__segment">
              <input
                type="radio"
                name={`${uid}-bots`}
                className="visually-hidden"
                checked={botCount === count}
                onChange={() => onBotCount(count)}
                aria-label={`${count} ${count === 1 ? "bot" : "bots"}`}
              />
              <span aria-hidden="true">{count}</span>
            </label>
          ))}
        </div>
        <p className="setup__meta">You roll first, then {opponents.join(", ")}.</p>
      </fieldset>
    </>
  );
}
