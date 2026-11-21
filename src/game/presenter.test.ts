import { afterEach, describe, expect, test, vi } from "vitest";
import { applyIntent, replayLog, type Intent, type LogEntry } from "./log";
import type { GameInput } from "./machine";
import { Presenter } from "./presenter";
import { createLocalSession, type GameSession, type SessionState } from "./session";
import type { DieValue } from "./scoring";

const input: GameInput = { players: ["Ada", "Bo"] };

function scriptedLog(steps: Array<[Intent, DieValue[]?]>): LogEntry[] {
  const log: LogEntry[] = [];
  for (const [intent, values = []] of steps) {
    let i = 0;
    const snapshot = replayLog(input, log);
    const r = applyIntent(snapshot, log.length, snapshot.context.current, intent, () => values[i++]!);
    if (!r.ok) throw new Error(r.reason);
    log.push(...r.entries);
  }
  return log;
}

/** A session whose log the test controls, standing in for an online session. */
function fakeSession(initial: Partial<SessionState> & { log: LogEntry[] }) {
  const listeners = new Set<() => void>();
  let state: SessionState = { gameNumber: 1, input, mySeats: [1], seenFrom: 0, connected: true, presence: [true, true], ...initial };
  const seen: number[] = [];
  const session: GameSession = {
    kind: "online",
    getState: () => state,
    subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    sendIntent: vi.fn(),
    markSeen: (seq) => seen.push(seq),
  };
  const append = (entries: LogEntry[]) => {
    state = { ...state, log: [...state.log, ...entries] };
    listeners.forEach((l) => l());
  };
  return { session, append, seen };
}

let presenter: Presenter | undefined;
afterEach(() => {
  presenter?.stop();
  presenter = undefined;
  vi.useRealTimers();
});

describe("Presenter", () => {
  test("holds each throw until the scene reports it settled", () => {
    const session = createLocalSession({ input });
    presenter = new Presenter(session, { pacing: 0 });
    session.sendIntent({ type: "roll" });

    const pending = presenter.getView().pendingThrow!;
    expect(pending.indices).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pending.values).toHaveLength(6);
    expect(presenter.actor.getSnapshot().matches({ playing: "rolling" })).toBe(true);
    expect(presenter.canAct()).toBe(false);

    presenter.throwSettled(pending.seq);
    expect(presenter.getView().pendingThrow).toBeNull();
    const snap = presenter.actor.getSnapshot();
    expect(snap.matches({ playing: "rolling" })).toBe(false);
    expect(snap.context.dice.map((d) => d.value)).toEqual(pending.values);
  });

  test("applies already-seen entries instantly and replays the rest with pauses", () => {
    vi.useFakeTimers();
    // Ada (seat 0) rolls, keeps a 1, and banks; we are Bo (seat 1) and saw nothing yet.
    const log = scriptedLog([[{ type: "roll" }, [1, 2, 3, 4, 6, 6]], [{ type: "toggleDie", index: 0 }], [{ type: "bank" }]]);
    const { session } = fakeSession({ log, seenFrom: 0 });
    presenter = new Presenter(session);

    expect(presenter.getView().replaying).toBe(true);
    expect(presenter.getView().fed).toBe(1); // `roll` fed, throw pending
    presenter.throwSettled(presenter.getView().pendingThrow!.seq);
    expect(presenter.getView().fed).toBe(2);

    vi.advanceTimersByTime(10_000);
    expect(presenter.getView().fed).toBe(4);
    expect(presenter.getView().replaying).toBe(false);
    expect(presenter.actor.getSnapshot().context.players[0]!.score).toBe(100);
    expect(presenter.canAct()).toBe(true); // Bo's turn now
  });

  test("skip jumps to the latest state and bumps snapCount", () => {
    const log = scriptedLog([[{ type: "roll" }, [1, 2, 3, 4, 6, 6]], [{ type: "toggleDie", index: 0 }], [{ type: "bank" }]]);
    const { session, seen } = fakeSession({ log, seenFrom: 0 });
    presenter = new Presenter(session);
    presenter.skip();

    const view = presenter.getView();
    expect(view).toMatchObject({ fed: 4, replaying: false, pendingThrow: null, snapCount: 1 });
    expect(presenter.actor.getSnapshot().context.current).toBe(1);
    expect(seen.at(-1)).toBe(4);
  });

  test("opening mid-throw never splits roll from rolled", () => {
    const log = scriptedLog([[{ type: "roll" }, [1, 2, 3, 4, 6, 6]]]);
    const { session } = fakeSession({ log, seenFrom: 1 });
    presenter = new Presenter(session);
    expect(presenter.getView()).toMatchObject({ fed: 2, replaying: false, pendingThrow: null });
  });

  test("live entries from the server are presented as they arrive", () => {
    const { session, append } = fakeSession({ log: [], mySeats: [0] });
    presenter = new Presenter(session, { pacing: 0 });
    expect(presenter.canAct()).toBe(true);

    const entries = scriptedLog([[{ type: "roll" }, [5, 2, 3, 4, 6, 6]]]);
    append(entries);
    expect(presenter.getView().pendingThrow?.values).toEqual([5, 2, 3, 4, 6, 6]);
    presenter.throwSettled(1);
    expect(presenter.actor.getSnapshot().matches({ playing: "choosing" })).toBe(true);
  });
});
