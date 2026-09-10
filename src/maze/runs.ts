import { sha256, stringToBytes } from "viem";
import {
  atExit, canMove, DIRECTION_NAMES, everythingKnown, indexOf, learn, moved, nothingKnown, START,
  type Direction, type Known, type Point,
} from "./grid.ts";
import { round, type RoundId } from "./round.ts";

/**
 * What happened in a run, written down so somebody else can check it.
 *
 * A leaderboard nobody can audit is a leaderboard nobody should believe, and this one eventually
 * claims things on chain — the reputation written when an agent solves a maze points at one of
 * these records and commits to its hash. So a record is not a log. It is the evidence.
 *
 * The maze is derived from the round id and the generator is deterministic, so a record carries
 * only *what the agent did*. Anyone can rebuild the maze from the id, walk the actions, and confirm
 * three things independently of us: that every move was legal, that the run ended where it claims,
 * and that the total charged matches the actions taken. `verify` is that check, and the server uses
 * the same function — there is no privileged path that skips it.
 */

export type Action = "move" | "look" | "map";
export type Outcome = "running" | "solved" | "gave-up";

/** Prices in dollars, which is how they are decided and displayed. */
export const PRICES: Readonly<Record<Action, number>> = { move: 0.001, look: 0.002, map: 0.01 };

/**
 * Money is held to six decimals throughout: the ERC-20 view of USDC cannot express more.
 *
 * Named for what it produces rather than what it does, because `round` in this file already means
 * a round of the tournament, and two different `round`s one screen apart is how a maintainer ends
 * up rounding a maze or scheduling a number.
 */
const usdc = (n: number): number => Number(n.toFixed(6));

/** A move records where it went and whether it went anywhere; other actions have no direction. */
export type PublishedAction =
  | { readonly action: "move"; readonly price: number; readonly direction: Direction;
      readonly settlement?: string }
  | { readonly action: "look" | "map"; readonly price: number; readonly settlement?: string };

/**
 * What Circle returned when the payment settled.
 *
 * Present means the facilitator accepted it into a batch, not that the batch has landed on chain —
 * those are about a quarter of an hour apart, and conflating them would publish a claim as a fact.
 * Carried on the action rather than the run because each action is its own payment.
 */
type Settled = { readonly settlement?: string };

interface RecordedMove extends Settled {
  readonly action: "move";
  readonly price: number;
  readonly direction: Direction;
  /** False when the move hit a wall: charged for, but it advanced nothing. */
  readonly moved: boolean;
}
type RecordedAction =
  | RecordedMove
  | (Settled & { readonly action: "look" | "map"; readonly price: number });

export interface Run {
  readonly id: string;
  readonly roundId: RoundId;
  /**
   * Whoever paid for the first action, and nobody else afterwards.
   *
   * Starting a run is free, so at that moment there is no payer to name — identity arrives with
   * the first payment and is pinned there. Without the pinning, one agent could ride another's
   * maze: run ids are guessable in the sense that they travel, and a leaderboard entry has to
   * belong to whoever actually bought the steps.
   */
  payer: string | null;
  /**
   * The ERC-8004 identity this run's reputation goes to, once we have checked it is really theirs.
   *
   * Declared by the agent — the registry has no reverse lookup — and only kept after
   * `getAgentWallet` confirms it against the payer. Null is ordinary: an agent with no identity
   * plays exactly the same maze and simply earns no record.
   */
  agentId: bigint | null;
  readonly startedAt: string;
  at: Point;
  actions: RecordedAction[];
  spentUsd: number;
  steps: number;
  outcome: Outcome;
  finishedAt: string | null;
  /**
   * Payments the facilitator accepted into a batch. Counted as they arrive rather than recounted
   * from the action list, because the boards ask every run for this on every request — and the
   * action list has no upper bound, so that made a public endpoint cost O(every action ever taken).
   */
  settlements: number;
}

/** The public shape: everything needed to check a run, and nothing a verifier can recompute. */
export interface PublishedRun {
  readonly id: string;
  readonly round: RoundId;
  readonly payer: string | null;
  /**
   * The identity this run is credited to, or null if it declared none.
   *
   * In the record because the record is the evidence. A party re-deriving the verdict from public
   * data — the Chainlink workflow does exactly this — must not have to be *told* whose reputation
   * to write: being told is the thing that re-introduces trust in whoever does the telling. The
   * server checked this against the payer before the run was published, and `payer` is here beside
   * it so the check can be repeated by anyone.
   */
  readonly agentId: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: Outcome;
  readonly steps: number;
  readonly spentUsd: number;
  readonly optimalSteps: number;
  /** Payments accepted into a batch. Not proof any of them has settled on chain. */
  readonly settlements: number;
  readonly actions: readonly PublishedAction[];
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly endedAt: Point;
  readonly steps: number;
  readonly spentUsd: number;
}

/**
 * The runs, owned rather than global.
 *
 * A module-level Map would make every test depend on the order of the ones before it, and would
 * leave nowhere to put the bound this needs — a process serving a round an hour, indefinitely,
 * accumulates runs until it dies. Handing the store to whoever constructs the server also means a
 * durable one can replace it later without touching anything that reads a run.
 */
/**
 * How many runs a process keeps.
 *
 * High enough that a real round never brushes it, low enough that the memory is bounded — the
 * number matters less than the eviction order below, which is what stops a free endpoint filling
 * it.
 */
const DEFAULT_LIMIT = 10_000;

export class RunStore {
  readonly #runs = new Map<string, Run>();
  readonly #limit: number;

  constructor(limit = DEFAULT_LIMIT) {
    this.#limit = limit;
  }

  start(input: { roundId: RoundId; payer?: string; agentId?: bigint }): Run {
    const run: Run = {
      id: newRunId(),
      roundId: input.roundId,
      payer: input.payer?.toLowerCase() ?? null,
      agentId: input.agentId ?? null,
      startedAt: new Date().toISOString(),
      at: { ...START },
      actions: [],
      spentUsd: 0,
      steps: 0,
      outcome: "running",
      finishedAt: null,
      settlements: 0,
    };
    this.#runs.set(run.id, run);
    this.#evictIfFull();
    return run;
  }

  get(id: string): Run | undefined {
    return this.#runs.get(id);
  }

  /** How many runs this payer has already claimed in a round. Bounds one agent's share of a board. */
  countFor(roundId: RoundId, payer: string): number {
    const who = payer.toLowerCase();
    let n = 0;
    for (const run of this.#runs.values()) {
      if (run.roundId === roundId && run.payer === who) n += 1;
    }
    return n;
  }

  forRound(roundId: RoundId): readonly Run[] {
    return [...this.#runs.values()].filter((run) => run.roundId === roundId);
  }

  all(): readonly Run[] {
    return [...this.#runs.values()];
  }

  get size(): number {
    return this.#runs.size;
  }

  /**
   * Make room, preferring the runs nobody has paid for.
   *
   * Starting a run is free, so an unpaid one is the cheapest thing in here and the only thing an
   * attacker can make in quantity — `POST /game` in a loop grew this without bound when eviction
   * skipped anything still "running", because a run nobody has paid for is running forever.
   *
   * The order is therefore: an unclaimed run first (it cost its creator nothing and cost us a map
   * entry), then a finished one (a leaderboard entry, which is a real loss). A run that has been
   * *paid for and is still in progress* is never dropped — taking an agent's maze away mid-step
   * after it bought those steps is the one outcome worth growing memory to avoid.
   *
   * Anything that must outlive this carries its own copy: the reputation written on chain quotes
   * the run's digest rather than pointing back into here.
   */
  #evictIfFull(): void {
    if (this.#runs.size <= this.#limit) return;
    let finished: string | undefined;
    for (const [id, run] of this.#runs) {
      if (run.payer === null) {
        this.#runs.delete(id);
        return;
      }
      if (finished === undefined && run.outcome !== "running") finished = id;
    }
    if (finished !== undefined) this.#runs.delete(finished);
  }
}

/**
 * Record one paid action.
 *
 * A run belongs to the round it started in, even after the hour turns. Cutting an agent off
 * mid-maze because a clock ticked would punish it for the hour it happened to enter, and it has
 * already paid for the steps it took. It scores against its own round; it simply cannot *start* a
 * run in an hour that has closed.
 */
export function record(run: Run, entry: RecordedAction): Run {
  run.actions.push(entry);
  run.spentUsd = usdc(run.spentUsd + entry.price);
  if (entry.settlement !== undefined) run.settlements += 1;
  if (entry.action === "move" && entry.moved) run.steps += 1;
  return run;
}

/**
 * Bind a run to its payer, or say it belongs to somebody else.
 *
 * Idempotent for the payer who already owns it, so a retry after a dropped response is not an
 * accusation of theft.
 */
export function claim(run: Run, payer: string): { readonly ok: boolean } {
  const who = payer.toLowerCase();
  if (run.payer === null) {
    run.payer = who;
    return { ok: true };
  }
  return { ok: run.payer === who };
}

export const move = (run: Run, direction: Direction, didMove: boolean, settlement?: string): Run =>
  record(run, {
    action: "move", price: PRICES.move, direction, moved: didMove,
    ...(settlement === undefined ? {} : { settlement }),
  });

export const look = (run: Run, settlement?: string): Run =>
  record(run, { action: "look", price: PRICES.look, ...(settlement === undefined ? {} : { settlement }) });

export const map = (run: Run, settlement?: string): Run =>
  record(run, { action: "map", price: PRICES.map, ...(settlement === undefined ? {} : { settlement }) });

export function finish(run: Run, outcome: Exclude<Outcome, "running">): Run {
  run.outcome = outcome;
  run.finishedAt = new Date().toISOString();
  return run;
}

export function published(run: Run): PublishedRun {
  return {
    id: run.id,
    round: run.roundId,
    payer: run.payer,
    // Stringified: the registry's ids are uint256 and JSON has no integer wide enough to hold one
    // without silently rounding it. A record is read back by strangers, in other languages.
    agentId: run.agentId === null ? null : String(run.agentId),
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    steps: run.steps,
    spentUsd: run.spentUsd,
    optimalSteps: round(run.roundId).optimalSteps,
    settlements: run.settlements,
    actions: run.actions.map((entry) => {
      const settled = entry.settlement === undefined ? {} : { settlement: entry.settlement };
      return entry.action === "move"
        ? { action: "move" as const, price: entry.price, direction: entry.direction, ...settled }
        : { action: entry.action, price: entry.price, ...settled };
    }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A stable digest of a published record, for the on-chain reputation to commit to.
 *
 * Keys are sorted before hashing, because JSON key order is an implementation detail and a hash
 * that depends on it breaks the moment a serializer changes. Whatever goes on chain has to be
 * reproducible from the published record years later, by someone using another language.
 */
/**
 * A fresh run id, from whatever this runtime calls Web Crypto.
 *
 * Reached through `globalThis` and typed here rather than relying on an ambient `crypto`, because
 * this module is compiled in two places with different type environments: the server, and a
 * Chainlink enclave that re-executes runs as plain JavaScript. `node:crypto` is available in
 * neither one of them and would fail at import.
 *
 * The enclave never starts a run — it only replays finished ones — so this is unreachable there.
 * It throws rather than inventing an id, because a run whose identity is not unique is a run whose
 * record can be overwritten by another.
 */
function newRunId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto?.randomUUID === undefined) {
    throw new Error("this runtime has no crypto.randomUUID, so a run cannot be given an identity");
  }
  return webCrypto.randomUUID();
}

/**
 * The score: 100 when the run walked the shortest route there is, lower the further it wandered.
 *
 * It lives here, with the run, rather than with the code that writes it to a chain — because it is
 * now computed in two places that must agree exactly. The server computes it to show on a page, and
 * a Chainlink enclave computes it from the same published record to decide what goes on chain. If
 * those two ever disagree, the number a person reads and the number an agent is judged by are
 * different numbers, and the on-chain one wins silently.
 *
 * Efficiency rather than steps or cost because both of those are better when *lower*, and a
 * reputation value that improves as it shrinks will be misread by the first person who does not
 * read the unit.
 */
export const efficiency = (run: PublishedRun): number =>
  run.steps <= 0 ? 0 : Math.round((run.optimalSteps / run.steps) * 100);

export function digest(value: unknown): `0x${string}` {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isRecord(value)) {
      const entries = Object.entries(value).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0);
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  };
  return sha256(stringToBytes(canonical(value)));
}

/**
 * Replay a published record against the maze its round implies.
 *
 * This is what a stranger runs. It takes nothing on trust: not the ending square, not the step
 * count, not the amount charged. A record that fails here is a claim we should not be publishing,
 * whether it failed because of a bug or because somebody edited it.
 */
/**
 * What this run has paid to find out, replayed from its own record.
 *
 * The same walk `verify` does, kept separate because they answer different questions: verify asks
 * whether the record holds up, this asks what the agent could see. Sharing a loop would tangle an
 * audit with a drawing.
 *
 * Each action buys a different fact. A move that lands proves the wall it crossed was open; a move
 * that does not proves it was shut — the agent paid either way, and learned either way. A look
 * settles every wall of the cell it was standing in. The map settles all of them.
 */
export function discovered(run: PublishedRun): Known {
  const { cells } = round(run.round);
  let known = nothingKnown();
  const visited = new Set<number>([indexOf(START)]);
  let at: Point = { ...START };

  for (const entry of run.actions) {
    // Checked positively: the other two share one union member, so excluding them narrows nothing.
    if (entry.action === "move") {
      known = learn(known, at.x, at.y, entry.direction);
      if (canMove(cells, at.x, at.y, entry.direction)) {
        at = moved(at.x, at.y, entry.direction);
        visited.add(indexOf(at));
      }
    } else if (entry.action === "map") {
      known = everythingKnown();
    } else {
      for (const d of DIRECTION_NAMES) known = learn(known, at.x, at.y, d);
    }
  }
  return { walls: known.walls, visited };
}

export function verify(run: PublishedRun): VerifyResult {
  const problems: string[] = [];
  const { cells } = round(run.round);
  let at: Point = { ...START };
  let steps = 0;
  let spent = 0;

  for (const [i, entry] of run.actions.entries()) {
    const price = PRICES[entry.action];
    if (entry.price !== price) {
      problems.push(`action ${i}: charged ${entry.price}, tariff is ${price}`);
    }
    spent += price;
    if (entry.action !== "move") continue;

    // A move into a wall is a legal *purchase* — the agent paid to learn the wall was there — so it
    // costs money and changes nothing. Only a move that could actually happen advances the count.
    if (canMove(cells, at.x, at.y, entry.direction)) {
      at = moved(at.x, at.y, entry.direction);
      steps += 1;
    }
  }

  const total = usdc(spent);
  if (run.spentUsd !== total) {
    problems.push(`spend says ${run.spentUsd}, actions total ${total}`);
  }
  if (run.steps !== steps) problems.push(`steps says ${run.steps}, actions give ${steps}`);
  if (run.outcome === "solved" && !atExit(at.x, at.y)) {
    problems.push(`claims solved but the actions end at ${at.x},${at.y}`);
  }
  if (run.outcome !== "solved" && atExit(at.x, at.y)) {
    problems.push("reached the exit but is not recorded as solved");
  }
  return { ok: problems.length === 0, problems, endedAt: at, steps, spentUsd: total };
}
