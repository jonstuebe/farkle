/**
 * End-to-end check of online rooms against a running dev server, over real WebSockets.
 *
 *   bun run dev                                  # in one terminal
 *   bun run smoke                                # in another (default http://localhost:5173)
 *   bun run smoke http://localhost:5180          # or name the server
 *
 * Covers: host opens a room, guests join, rules, start, turns with seq, a stale seq, a move out
 * of turn, malformed messages, disconnect + reconnect, seen marks, summaries, a whole game to
 * the end, rematch, cancelling a lobby, leaving a lobby, a full lobby, and the HTTP error cases.
 * Every room uses a fresh random code, so it is safe to run again and again.
 */
import { replayLog, type GameSnapshot, type Intent } from "../src/game/log.ts";
import { selectionScore } from "../src/game/machine.ts";
import {
  CLOSE_CANCELLED,
  CLOSE_REFUSED,
  MAX_SEATS,
  newRoomCode,
  type ClientMessage,
  type RoomSummary,
  type RoomView,
  type ServerMessage,
} from "../src/net/protocol.ts";

const base = (process.argv[2] ?? process.env.ROOM_SMOKE_URL ?? "http://localhost:5173").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const TIMEOUT_MS = 5000;

let checks = 0;
function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${label}`);
  checks++;
  console.log(`  ok  ${label}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const newDevice = () => crypto.randomUUID();

type Playing = Extract<RoomView, { phase: "playing" }>;

/** One device's connection: keeps what the server sent and lets the test wait for messages. */
class Client {
  readonly inbox: ServerMessage[] = [];
  seat = -1;
  room: RoomView | null = null;
  presence: boolean[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: (() => void)[] = [];
  private socket: WebSocket;

  constructor(
    readonly label: string,
    code: string,
    readonly device: string,
    name: string | null,
    intent: "host" | "join",
  ) {
    const query = new URLSearchParams({ device, intent });
    if (name !== null) query.set("name", name);
    this.socket = new WebSocket(`${wsBase}/api/rooms/${code}/socket?${query}`);
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      this.inbox.push(message);
      if (message.type === "room") {
        this.seat = message.seat;
        this.room = message.room;
        this.presence = message.room.seats.map((s) => s.connected);
      } else if (message.type === "appended" && this.room?.phase === "playing") {
        if (message.gameNumber === this.room.gameNumber && message.entries[0]?.seq === this.room.log.length) {
          this.room = { ...this.room, log: [...this.room.log, ...message.entries] };
        }
      } else if (message.type === "presence") {
        this.presence = message.connected;
      } else if (message.type === "refused") {
        // The server closes the socket right after this. A client shouldn't count on that close
        // arriving (see README, "Online rooms"), so like the real client this one hangs up itself
        // if it hasn't come shortly.
        setTimeout(() => this.closed ?? this.socket.close(1000), 500);
      }
      this.wake();
    });
    this.socket.addEventListener("close", (event) => {
      this.closed = { code: event.code, reason: event.reason };
      this.wake();
    });
  }

  private wake() {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /** Resolves once `done()` is true, checking again after every message. */
  async until(done: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + TIMEOUT_MS;
    while (!done()) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`FAILED: ${this.label} timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** The next message of `type` that arrives from now on. */
  async next<T extends ServerMessage["type"]>(type: T, from = this.inbox.length) {
    let found: ServerMessage | undefined;
    await this.until(() => (found = this.inbox.slice(from).find((m) => m.type === type)) !== undefined, type);
    return found as Extract<ServerMessage, { type: T }>;
  }

  send(message: ClientMessage | string) {
    this.socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  get playing(): Playing {
    if (this.room?.phase !== "playing") throw new Error(`FAILED: ${this.label} is not in a game`);
    return this.room;
  }

  snapshot(): GameSnapshot {
    return replayLog(this.playing.input, this.playing.log);
  }

  async close() {
    this.socket.close(1000);
    await this.until(() => this.closed !== null, "close");
  }

  /** Nothing arrives for a little while (for messages the server must ignore). */
  async quiet(what: string, ms = 300) {
    const before = this.inbox.length;
    await new Promise((resolve) => setTimeout(resolve, ms));
    check(this.inbox.length === before, `${this.label} hears nothing after ${what}`);
  }
}

async function connect(label: string, code: string, device: string, name: string | null, intent: "host" | "join") {
  const client = new Client(label, code, device, name, intent);
  await client.until(() => client.room !== null || client.closed !== null, "the room");
  return client;
}

const summary = async (code: string, device: string) =>
  (await (await fetch(`${base}/api/rooms/${code}/summary?device=${device}`)).json()) as RoomSummary;

/** The dice to keep from the latest roll: the first selection that scores. */
function pickDice(snapshot: GameSnapshot): number[] {
  const { dice } = snapshot.context;
  const free = dice.flatMap((die, i) => (die.held ? [] : [i]));
  const onesAndFives = free.filter((i) => dice[i]!.value === 1 || dice[i]!.value === 5);
  if (onesAndFives.length > 0) return onesAndFives;
  for (const face of [2, 3, 4, 6]) {
    const matching = free.filter((i) => dice[i]!.value === face);
    if (matching.length >= 3) return matching;
  }
  return free; // three pairs
}

/** Everyone at the table has the same log. */
async function inSync(clients: Client[], length: number) {
  await Promise.all(clients.map((c) => c.until(() => c.playing.log.length >= length, `log length ${length}`)));
}

/**
 * The player whose turn it is rolls once, then banks if the game allows it, otherwise keeps
 * rolling; a farkle passes the dice. Returns when the turn has moved on (or the game ended).
 */
async function takeTurn(clients: Client[]): Promise<void> {
  const seatUp = clients[0]!.snapshot().context.current;
  const player = clients.find((c) => c.seat === seatUp)!;
  const act = async (intent: Intent) => {
    const seq = player.playing.log.length;
    player.send({ type: "intent", seq, intent });
    await player.until(() => player.playing.log.length > seq, `${intent.type} to be appended`);
  };

  await act({ type: "roll" });
  for (;;) {
    let snapshot = player.snapshot();
    if (snapshot.status !== "active" || snapshot.context.current !== seatUp) break;
    if (snapshot.matches({ playing: "farkled" })) {
      await act({ type: "passTurn" });
      break;
    }
    for (const index of pickDice(snapshot)) await act({ type: "toggleDie", index });
    snapshot = player.snapshot();
    if (selectionScore(snapshot.context) === null) throw new Error("FAILED: picked dice that don't score");
    const before = player.playing.log.length;
    player.send({ type: "intent", seq: before, intent: { type: "bank" } });
    // Banking is refused below the entry threshold: the server answers with the room instead.
    const from = player.inbox.length;
    await player.until(
      () => player.playing.log.length > before || player.inbox.slice(from).some((m) => m.type === "room"),
      "bank",
    );
    if (player.playing.log.length > before) break;
    await act({ type: "keepAndRoll" });
  }
  await inSync(clients, player.playing.log.length);
}

// -----------------------------------------------------------------------------------------------

async function main() {
  console.log(`Room smoke test against ${base}\n`);
  const code = newRoomCode();
  const [hostId, guestAId, guestBId] = [newDevice(), newDevice(), newDevice()];

  console.log(`Lobby (${code})`);
  check((await summary(code, hostId)).status === "missing", "summary of a room nobody made is missing");
  const stray = await connect("stray", code, newDevice(), "Stray", "join");
  await stray.until(() => stray.closed !== null, "close");
  check(same(stray.inbox, [{ type: "refused", reason: "missing" }]), "joining a room nobody made is refused: missing");
  check(stray.closed?.code === CLOSE_REFUSED, `...and closed with ${CLOSE_REFUSED}`);
  check((await summary(code, hostId)).status === "missing", "the refused join left no room behind");

  const host = await connect("host", code, hostId, "  Ada \u0007 Lovelace  ", "host");
  check(host.seat === 0 && host.room?.phase === "lobby", "host opens the room and gets seat 0");
  check(host.room?.seats[0]?.name === "Ada Lovelace", "the host's name is cleaned");
  check(host.room?.code === code, "the room knows its code");

  let from = host.inbox.length;
  const guestA = await connect("guest A", code, guestAId, "Bo", "join");
  const guestB = await connect("guest B", code, guestBId, null, "join");
  check(guestA.seat === 1 && guestB.seat === 2, "two guests join and get seats 1 and 2");
  await host.until(() => host.room?.seats.length === 3, "three seats");
  check(host.inbox.slice(from).filter((m) => m.type === "room").length >= 2, "the host is told about each arrival");
  check(same(host.room?.seats.map((s) => s.name), ["Ada Lovelace", "Bo", "Player 3"]), "seat names, with a stand-in");
  check(same(host.room?.seats.map((s) => s.connected), [true, true, true]), "everyone shows as connected");
  check(same(await summary(code, hostId), { status: "lobby", seats: ["Ada Lovelace", "Bo", "Player 3"], isHost: true }), "host's lobby summary");
  check(same(await summary(code, guestAId), { status: "lobby", seats: ["Ada Lovelace", "Bo", "Player 3"], isHost: false }), "guest's lobby summary");
  check((await summary(code, newDevice())).status === "notSeated", "a stranger's summary is notSeated");

  console.log("\nRules and start");
  from = guestA.inbox.length;
  guestA.send({ type: "configure", rules: { targetScore: 500 } });
  const refusedConfigure = await guestA.next("room", from);
  check(refusedConfigure.room.phase === "lobby" && refusedConfigure.room.rules.targetScore === 10_000, "a guest can't change the rules");
  from = guestA.inbox.length;
  guestA.send({ type: "start" });
  check((await guestA.next("room", from)).room.phase === "lobby", "a guest can't start the game");

  // A target nobody reaches in their first turn or two, so the game is still on for the
  // disconnect and reconnect checks below.
  host.send({ type: "configure", rules: { targetScore: 3000, entryThreshold: 500 } });
  await guestB.until(() => guestB.room?.phase === "lobby" && guestB.room.rules.targetScore === 3000, "new rules");
  check(guestB.room?.phase === "lobby" && guestB.room.rules.entryThreshold === 500, "the host's rules reach the guests");
  await host.until(() => host.room?.phase === "lobby" && host.room.rules.targetScore === 3000, "new rules");

  host.send("not json");
  host.send(JSON.stringify({ type: "shuffle" }));
  host.send(JSON.stringify({ type: "configure", rules: { targetScore: 5 } }));
  host.send(JSON.stringify({ type: "intent", seq: 0, intent: { type: "rolled", values: [1, 1, 1, 1, 1, 1] } }));
  await host.quiet("malformed and unknown messages");

  host.send({ type: "start" });
  const table = [host, guestA, guestB];
  await Promise.all(table.map((c) => c.until(() => c.room?.phase === "playing", "the game")));
  const started = guestA.playing;
  check(started.gameNumber === 1 && started.log.length === 0 && same(started.seen, [0, 0, 0]), "game 1 starts with an empty log, nothing seen");
  check(same(started.input.players, ["Ada Lovelace", "Bo", "Player 3"]), "players are the seat names");
  check(started.input.rules?.targetScore === 3000 && started.input.rules.entryThreshold === 500, "the game uses the lobby's rules");

  const late = await connect("late", code, newDevice(), "Late", "join");
  await late.until(() => late.closed !== null, "close");
  check(same(late.inbox, [{ type: "refused", reason: "started" }]) && late.closed?.code === CLOSE_REFUSED, "a new device after the start is refused: started");

  console.log("\nTurns");
  host.send({ type: "intent", seq: 0, intent: { type: "roll" } });
  await inSync(table, 2);
  const [roll, rolled] = guestB.playing.log;
  check(roll?.seq === 0 && roll.seat === 0 && roll.event.type === "roll", "a roll is appended for everyone");
  check(
    rolled?.seq === 1 && rolled.event.type === "rolled" && rolled.event.values.length === 6 && rolled.event.values.every((v) => v >= 1 && v <= 6),
    "the server rolled six dice",
  );
  check(same(host.playing.log, guestA.playing.log) && same(host.playing.log, guestB.playing.log), "all three have the same log");

  from = host.inbox.length;
  host.send({ type: "intent", seq: 0, intent: { type: "roll" } });
  const stale = await host.next("room", from);
  check(stale.room.phase === "playing" && stale.room.log.length === 2, "a stale seq is rejected: the sender gets the current room");
  from = guestA.inbox.length;
  guestA.send({ type: "intent", seq: 2, intent: { type: "roll" } });
  const outOfTurn = await guestA.next("room", from);
  check(outOfTurn.room.phase === "playing" && outOfTurn.room.log.length === 2, "a move out of turn is rejected the same way");
  await guestB.quiet("other players' rejected moves");
  check(guestB.playing.log.length === 2, "rejected moves append nothing");

  // Finish the host's turn (their first roll is already on the table), then one more turn.
  const finishHostTurn = async () => {
    for (;;) {
      const snapshot = host.snapshot();
      if (snapshot.context.current !== 0) return;
      const seq = host.playing.log.length;
      if (snapshot.matches({ playing: "farkled" })) {
        host.send({ type: "intent", seq, intent: { type: "passTurn" } });
        await host.until(() => host.playing.log.length > seq, "passTurn");
        return;
      }
      const picks = pickDice(snapshot);
      for (const [n, index] of picks.entries()) host.send({ type: "intent", seq: seq + n, intent: { type: "toggleDie", index } });
      host.send({ type: "intent", seq: seq + picks.length, intent: { type: "keepAndRoll" } });
      await host.until(() => host.playing.log.length >= seq + picks.length + 2, "keepAndRoll");
    }
  };
  await finishHostTurn();
  await inSync(table, host.playing.log.length);
  check(guestA.snapshot().context.current === 1, "the turn passes to seat 1");
  await takeTurn(table);
  check(host.snapshot().context.current === 2, "seat 1 plays and the turn passes to seat 2");

  console.log("\nSeen, disconnect, reconnect");
  const lengthAtLeave = guestA.playing.log.length;
  guestA.send({ type: "seen", seq: lengthAtLeave });
  // `seen` gets no reply, so ask until the Room has it before hanging up.
  for (let tries = 0; ; tries++) {
    const mine = await summary(code, guestAId);
    if ("unseen" in mine && mine.unseen === 0) break;
    if (tries > 50) throw new Error("FAILED: the Room never recorded guest A's seen mark");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(true, "a seen mark is recorded");
  from = host.inbox.length;
  await guestA.close();
  const left = await host.next("presence", from);
  check(same(left.connected, [true, false, true]), "the others see guest A disconnect");

  await takeTurn([host, guestB]);
  await takeTurn([host, guestB]);
  check(host.snapshot().context.current === 1, "play goes on without them until it's their turn");
  const missed = host.playing.log.length - lengthAtLeave;
  const away = await summary(code, guestAId);
  check(away.status === "yourTurn" && away.unseen === missed && away.current === "Bo", `guest A's summary: your turn, ${missed} new moves`);
  const waiting = await summary(code, hostId);
  check(waiting.status === "theirTurn" && waiting.unseen === host.playing.log.length, "the host's summary: their turn (the host never sent seen)");

  from = host.inbox.length;
  const back = await connect("guest A again", code, guestAId, "Bobby", "join");
  check(back.seat === 1, "guest A reconnects and keeps seat 1");
  check(same(back.playing.log, host.playing.log), "...and gets the whole log");
  check(back.playing.seen[1] === lengthAtLeave, "...with their seen mark where they left it");
  await host.until(() => host.room?.seats[1]?.name === "Bobby" && host.presence[1] === true, "guest A back");
  check(host.room?.seats[1]?.name === "Bobby" && host.playing.input.players[1] === "Bo", "a new name shows on the seat; the game keeps the old one");
  back.send({ type: "seen", seq: 0 });
  back.send({ type: "seen", seq: 100_000 });
  await back.quiet("seen");
  const caughtUp = await summary(code, guestAId);
  check(caughtUp.status === "yourTurn" && caughtUp.unseen === 0, "seen never moves back and stops at the end of the log");

  console.log("\nTo the end, and a rematch");
  const players = [host, back, guestB];
  let turns = 0;
  while (host.snapshot().status === "active") {
    await takeTurn(players);
    if (++turns > 400) throw new Error("FAILED: the game never ended");
  }
  await inSync(players, host.playing.log.length);
  const final = host.snapshot();
  const scores = final.context.players.map((p) => p.score);
  const over = await summary(code, guestBId);
  check(over.status === "over" && same(over.scores, scores) && over.mySeat === 2, `the game ends after ${turns} more turns: ${scores.join(" / ")}`);
  check(over.status === "over" && same(over.winners, final.output?.winners), "the summary names the winners");
  check(Math.max(...scores) >= 3000, "someone reached the target");

  from = back.inbox.length;
  back.send({ type: "rematch", gameNumber: 7 });
  const wrongGame = await back.next("room", from);
  check(wrongGame.room.phase === "playing" && wrongGame.room.gameNumber === 1, "a rematch for the wrong game number is rejected");
  guestB.send({ type: "rematch", gameNumber: 1 });
  await Promise.all(players.map((c) => c.until(() => c.playing.gameNumber === 2, "game 2")));
  const second = host.playing;
  check(second.log.length === 0 && same(second.seen, [0, 0, 0]), "a rematch starts game 2 with an empty log");
  check(same(second.input.players, ["Ada Lovelace", "Bobby", "Player 3"]), "...for the same seats, with their current names");
  await takeTurn(players);
  check(host.playing.log.length > 0 && same(host.playing.log, guestB.playing.log), "game 2 plays");

  await host.close();
  const hostAgain = await connect("host again", code, hostId, null, "host");
  check(hostAgain.seat === 0 && hostAgain.playing.gameNumber === 2 && same(hostAgain.playing.log, guestB.playing.log), "after a rematch a reconnect gets game 2's log only");
  check(hostAgain.room?.seats[0]?.name === "Ada Lovelace", "connecting without a name keeps the old one");

  const cancelStarted = await fetch(`${base}/api/rooms/${code}/invite?device=${hostId}`, { method: "DELETE" });
  check(cancelStarted.status === 409, "a started game can't be cancelled (409)");
  await Promise.all([hostAgain, back, guestB].map((c) => c.close()));

  console.log("\nCancelling a lobby");
  const lobbyCode = newRoomCode();
  const lobbyHostId = newDevice();
  const lobbyHost = await connect("lobby host", lobbyCode, lobbyHostId, "Ada", "host");
  const lobbyGuestId = newDevice();
  const lobbyGuest = await connect("lobby guest", lobbyCode, lobbyGuestId, "Bo", "join");
  // NOTE: the local Workers runtime only delivers a server's close to a hibernating socket that
  // has sent something (cloudflare/workerd#8185), so both say something before the close codes
  // are checked.
  lobbyHost.send({ type: "configure", rules: { targetScore: 5000 } });
  await lobbyGuest.until(() => lobbyGuest.room?.phase === "lobby" && lobbyGuest.room.rules.targetScore === 5000, "new rules");
  const lobbyFrom = lobbyGuest.inbox.length;
  lobbyGuest.send({ type: "start" });
  await lobbyGuest.next("room", lobbyFrom);
  const notHost = await fetch(`${base}/api/rooms/${lobbyCode}/invite?device=${lobbyGuestId}`, { method: "DELETE" });
  check(notHost.status === 403, "a guest can't cancel the lobby (403)");
  check((await summary(lobbyCode, lobbyHostId)).status === "lobby", "...and it's still there");
  const cancelled = await fetch(`${base}/api/rooms/${lobbyCode}/invite?device=${lobbyHostId}`, { method: "DELETE" });
  check(cancelled.status === 204, "the host cancels the lobby (204)");
  await Promise.all([lobbyHost, lobbyGuest].map((c) => c.until(() => c.closed !== null, "close")));
  check(lobbyGuest.inbox.at(-1)?.type === "refused" && same(lobbyGuest.inbox.at(-1), { type: "refused", reason: "missing" }), "the guest is told the room is gone");
  check(lobbyGuest.closed?.code === CLOSE_CANCELLED && lobbyHost.closed?.code === CLOSE_CANCELLED, `both sockets close with ${CLOSE_CANCELLED}`);
  check((await summary(lobbyCode, lobbyHostId)).status === "missing", "the room is missing afterwards");
  const again = await fetch(`${base}/api/rooms/${lobbyCode}/invite?device=${lobbyHostId}`, { method: "DELETE" });
  check(again.status === 204, "cancelling a room that's already gone is fine (204)");
  const rejoin = await connect("rejoin", lobbyCode, lobbyGuestId, "Bo", "join");
  await rejoin.until(() => rejoin.closed !== null, "close");
  check(same(rejoin.inbox, [{ type: "refused", reason: "missing" }]), "the old invite link no longer works");

  console.log("\nLeaving a lobby");
  const leaveCode = newRoomCode();
  const leaveHost = await connect("host", leaveCode, newDevice(), "Ada", "host");
  const leaverId = newDevice();
  const leaver = await connect("leaver", leaveCode, leaverId, "Bo", "join");
  const stayer = await connect("stayer", leaveCode, newDevice(), "Cy", "join");
  const lastIn = await connect("last in", leaveCode, newDevice(), "Dee", "join");
  const leaverTab = await connect("leaver's other tab", leaveCode, leaverId, null, "join");
  check(same([leaver.seat, stayer.seat, lastIn.seat, leaverTab.seat], [1, 2, 3, 1]), "three guests are seated 1, 2, 3");
  await leaveHost.until(() => leaveHost.room?.seats.length === 4, "four seats");

  leaveHost.send({ type: "leave" });
  await leaveHost.quiet("the host's leave");
  const hostStill = await summary(leaveCode, leaveHost.device);
  check(hostStill.status === "lobby" && hostStill.seats.length === 4 && leaveHost.closed === null, "the host's leave is ignored");

  leaver.send({ type: "leave" });
  const stayers = [leaveHost, stayer, lastIn];
  await Promise.all(stayers.map((c) => c.until(() => c.room?.seats.length === 3, "three seats")));
  check(same(leaveHost.room?.seats.map((s) => s.name), ["Ada", "Cy", "Dee"]), "a guest leaves and their seat is gone");
  check(same(stayers.map((c) => c.seat), [0, 1, 2]), "the guests after them move up a seat");
  check(same(leaveHost.room?.seats.map((s) => s.connected), [true, true, true]), "everyone still there shows as connected");
  await leaver.until(() => leaver.closed !== null, "close");
  check(leaver.closed?.code === 1000, "the leaver's socket is closed (1000)");
  check(leaver.room?.seats.length === 4, "...and isn't sent the new room");
  await new Promise((resolve) => setTimeout(resolve, 300));
  check(leaverTab.room?.seats.length === 4, "their other tab stops hearing about the room too");
  check((await summary(leaveCode, leaverId)).status === "notSeated", "the leaver's summary is notSeated");
  check(same(await summary(leaveCode, lastIn.device), { status: "lobby", seats: ["Ada", "Cy", "Dee"], isHost: false }), "the others' summaries show three seats");

  leaveHost.send({ type: "start" });
  await Promise.all(stayers.map((c) => c.until(() => c.room?.phase === "playing", "the game")));
  check(same(stayer.playing.input.players, ["Ada", "Cy", "Dee"]), "the game starts with the three who stayed");
  await takeTurn(stayers);
  await takeTurn(stayers);
  await takeTurn(stayers);
  const seatsPlayed = [...new Set(leaveHost.playing.log.map((entry) => entry.seat))];
  check(same(seatsPlayed, [0, 1, 2]) && leaveHost.snapshot().context.current === 0, "all three take a turn in their new seats");
  check(same(lastIn.playing.log, leaveHost.playing.log), "...and share one log");

  lastIn.send({ type: "leave" });
  await lastIn.quiet("a leave after the start");
  await leaveHost.quiet("someone else's leave after the start");
  const stillIn = await summary(leaveCode, lastIn.device);
  check(stillIn.status === "theirTurn" && stillIn.seats.length === 3 && lastIn.closed === null, "a leave after the start is ignored");
  const tooLate = await connect("leaver again", leaveCode, leaverId, "Bo", "join");
  await tooLate.until(() => tooLate.closed !== null, "close");
  check(same(tooLate.inbox, [{ type: "refused", reason: "started" }]), "the leaver can't come back once the game has started");
  await Promise.all([...stayers, leaverTab].map((c) => c.close()));

  console.log("\nA full lobby");
  const fullCode = newRoomCode();
  const crowd: Client[] = [];
  for (let i = 0; i < MAX_SEATS; i++) {
    crowd.push(await connect(`player ${i + 1}`, fullCode, newDevice(), `P${i + 1}`, i === 0 ? "host" : "join"));
  }
  check(same(crowd.map((c) => c.seat), [0, 1, 2, 3, 4, 5, 6, 7]), `${MAX_SEATS} devices fill the lobby`);
  const ninth = await connect("ninth", fullCode, newDevice(), "P9", "join");
  await ninth.until(() => ninth.closed !== null, "close");
  check(same(ninth.inbox, [{ type: "refused", reason: "full" }]) && ninth.closed?.code === CLOSE_REFUSED, "the 9th device is refused: full");
  const second8 = await connect("player 8 again", fullCode, crowd[7]!.device, null, "join");
  check(second8.seat === 7, "a seated device still gets into a full lobby");
  crowd[0]!.send({ type: "start" });
  await crowd[7]!.until(() => crowd[7]!.room?.phase === "playing", "the game");
  check(crowd[7]!.playing.input.players.length === MAX_SEATS, `an ${MAX_SEATS}-player game starts`);
  await Promise.all([...crowd, second8].map((c) => c.close()));

  console.log("\nHTTP");
  const status = async (path: string, init?: RequestInit) => (await fetch(`${base}${path}`, init)).status;
  check((await status(`/api/rooms/abc/summary?device=${hostId}`)) === 404, "a bad code is 404");
  check((await status(`/api/rooms/${code}/nope?device=${hostId}`)) === 404, "an unknown route is 404");
  check((await status(`/api/rooms/${code}/summary?device=short`)) === 400, "a short device id is 400");
  check((await status(`/api/rooms/${code}/summary?device=${hostId}`, { method: "POST" })) === 405, "POST summary is 405");
  check((await status(`/api/rooms/${code}/invite?device=${hostId}`)) === 405, "GET invite is 405");
  check((await status(`/api/rooms/${code}/socket?device=${hostId}&intent=join`)) === 426, "socket without an upgrade is 426");
  const page = await fetch(`${base}/r/${code}`);
  check(page.status === 200 && (await page.text()).includes("<div id=\"root\">"), "an invite link serves the app");

  console.log(`\nAll ${checks} checks passed.`);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
