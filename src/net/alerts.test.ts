import { describe, expect, it } from "vitest";
import type { DieValue } from "../game/scoring";
import type { Intent } from "../game/log";
import { parsePushRegistration, parsePushRemoval, pushesFor, type Push } from "./alerts";
import { applyMessage, configure, seat, start, type PlayingRoom, type Room } from "./room";

const CODE = "ABCDEF";
const device = (n: number) => `device-${String(n).padStart(12, "0")}`;
const nobody = [false, false, false, false];

const dice = (...values: DieValue[]) => {
  let i = 0;
  return () => values[i++ % values.length]!;
};

function lobby(names: string[], targetScore = 10_000): Room {
  let room: Room | null = null;
  names.forEach((name, i) => {
    const seating = seat(room, device(i), i === 0 ? "host" : "join", name);
    if (!seating.ok) throw new Error(seating.reason);
    room = seating.room;
  });
  return configure(room!, 0, { targetScore });
}

function move(room: PlayingRoom, bySeat: number, intent: Intent, randomDie = dice(1)): PlayingRoom {
  const outcome = applyMessage(room, bySeat, { type: "intent", seq: room.log.length, intent }, randomDie);
  if (outcome.kind !== "appended") throw new Error(`${intent.type} by seat ${bySeat}: ${outcome.kind}`);
  return outcome.room;
}

/** Rolls 1,1,1 + junk and banks the 1000 (turn passes on). */
function bankThousand(room: PlayingRoom, bySeat: number): PlayingRoom {
  let next = move(room, bySeat, { type: "roll" }, dice(1, 1, 1, 2, 3, 4));
  for (const index of [0, 1, 2]) next = move(next, bySeat, { type: "toggleDie", index });
  return move(next, bySeat, { type: "bank" });
}

/** Rolls nothing that scores, then passes. */
const farkle = (room: PlayingRoom, bySeat: number): PlayingRoom =>
  move(move(room, bySeat, { type: "roll" }, dice(2, 3, 4, 6, 2, 3)), bySeat, { type: "passTurn" });

const notice = (title: string, body: string) => ({ title, body, url: `/r/${CODE}`, tag: `farkle-${CODE}` });

describe("pushesFor: a new game", () => {
  it("tells whoever goes first who they're playing", () => {
    const before = lobby(["Ada", "Bo", "Cy"]);
    const after = start(before, 0);
    expect(pushesFor(before, after, CODE, nobody)).toEqual<Push[]>([
      { seat: 0, notice: notice("Your turn", "Farkle with Bo, Cy: it's your turn.") },
    ]);
  });

  it("does the same for a rematch", () => {
    let game = start(lobby(["Ada", "Bo"], 1000), 0) as PlayingRoom;
    game = farkle(bankThousand(game, 0), 1);
    const outcome = applyMessage(game, 1, { type: "rematch", gameNumber: 1 });
    if (outcome.kind !== "room") throw new Error(outcome.kind);
    expect(pushesFor(game, outcome.room, CODE, nobody)).toEqual<Push[]>([
      { seat: 0, notice: notice("Your turn", "Farkle with Bo: it's your turn.") },
    ]);
  });

  it("says nothing about lobby changes", () => {
    const before = lobby(["Ada", "Bo"]);
    expect(pushesFor(before, configure(before, 0, { targetScore: 5000 }), CODE, nobody)).toEqual([]);
  });
});

describe("pushesFor: the turn passing", () => {
  const game = () => start(lobby(["Ada", "Bo", "Cy"]), 0) as PlayingRoom;

  it("tells the next player what the last one banked", () => {
    const before = game();
    expect(pushesFor(before, bankThousand(before, 0), CODE, nobody)).toEqual<Push[]>([
      { seat: 1, notice: notice("Your turn", "Ada banked 1,000. It's your turn.") },
    ]);
  });

  it("or that they farkled", () => {
    const rolled = move(game(), 0, { type: "roll" }, dice(2, 3, 4, 6, 2, 3));
    expect(pushesFor(rolled, move(rolled, 0, { type: "passTurn" }), CODE, nobody)).toEqual<Push[]>([
      { seat: 1, notice: notice("Your turn", "Ada farkled. It's your turn.") },
    ]);
  });

  it("says nothing for rolls and picks within a turn", () => {
    const before = game();
    const rolled = move(before, 0, { type: "roll" }, dice(1, 1, 1, 2, 3, 4));
    expect(pushesFor(before, rolled, CODE, nobody)).toEqual([]);
    expect(pushesFor(rolled, move(rolled, 0, { type: "toggleDie", index: 0 }), CODE, nobody)).toEqual([]);
  });

  it("skips a player whose game is open (connected)", () => {
    const before = game();
    expect(pushesFor(before, bankThousand(before, 0), CODE, [false, true, false])).toEqual([]);
  });
});

describe("pushesFor: the final round and the end", () => {
  // Three players to 1000: Ada reaches it on the first turn.
  const reached = () => {
    const before = start(lobby(["Ada", "Bo", "Cy"], 1000), 0) as PlayingRoom;
    return { before, after: bankThousand(before, 0) };
  };

  it("tells the next player that someone reached the target", () => {
    const { before, after } = reached();
    expect(pushesFor(before, after, CODE, nobody)).toEqual<Push[]>([
      { seat: 1, notice: notice("Last turn", "Ada reached 1,000. Last turn!") },
    ]);
  });

  it("and each one after, as their turn comes", () => {
    const { after } = reached();
    expect(pushesFor(after, farkle(after, 1), CODE, nobody)).toEqual<Push[]>([
      { seat: 2, notice: notice("Last turn", "Bo farkled. Ada reached 1,000. Last turn!") },
    ]);
  });

  it("tells everyone but the winner who won", () => {
    const { after } = reached();
    const lastTurn = farkle(after, 1);
    expect(pushesFor(lastTurn, farkle(lastTurn, 2), CODE, nobody)).toEqual<Push[]>([
      { seat: 1, notice: notice("Game over", "Ada wins with 1,000.") },
      { seat: 2, notice: notice("Game over", "Ada wins with 1,000.") },
    ]);
  });

  it("names everyone in a tie", () => {
    const two = start(lobby(["Ada", "Bo", "Cy"], 1000), 0) as PlayingRoom;
    const lastTurn = bankThousand(bankThousand(two, 0), 1);
    expect(pushesFor(lastTurn, farkle(lastTurn, 2), CODE, nobody)).toEqual<Push[]>([
      { seat: 2, notice: notice("Game over", "Ada and Bo tie with 1,000.") },
    ]);
  });

  it("says nothing more once the game is over", () => {
    const { after } = reached();
    const over = farkle(farkle(after, 1), 2);
    const outcome = applyMessage(over, 0, { type: "seen", seq: 3 });
    if (outcome.kind !== "seen") throw new Error(outcome.kind);
    expect(pushesFor(over, outcome.room, CODE, nobody)).toEqual([]);
  });
});

describe("parsePushRegistration and parsePushRemoval", () => {
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: { p256dh: "BAbc-_1", auth: "q2w3" } };

  it("keeps the known fields only", () => {
    expect(
      parsePushRegistration(JSON.stringify({ device: device(1), subscription: { ...subscription, expirationTime: null }, x: 1 })),
    ).toEqual({ device: device(1), subscription });
    expect(parsePushRemoval(JSON.stringify({ device: device(1), extra: true }))).toEqual({ device: device(1) });
  });

  it.each([
    ["not JSON", "{"],
    ["an array", "[]"],
    ["no device", JSON.stringify({ subscription })],
    ["a short device", JSON.stringify({ device: "short", subscription })],
    ["no subscription", JSON.stringify({ device: device(1) })],
    ["no keys", JSON.stringify({ device: device(1), subscription: { endpoint: subscription.endpoint } })],
    ["a bad endpoint", JSON.stringify({ device: device(1), subscription: { ...subscription, endpoint: "nope" } })],
    ["a file endpoint", JSON.stringify({ device: device(1), subscription: { ...subscription, endpoint: "file:///etc/passwd" } })],
    ["a key that isn't base64url", JSON.stringify({ device: device(1), subscription: { ...subscription, keys: { p256dh: "a b", auth: "x" } } })],
  ])("refuses %s", (_, text) => {
    expect(parsePushRegistration(text)).toBeNull();
  });

  it("refuses a removal without a device", () => {
    expect(parsePushRemoval("{}")).toBeNull();
    expect(parsePushRemoval("nope")).toBeNull();
  });
});
