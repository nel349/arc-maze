import { createHash, randomUUID } from "node:crypto";
import { atExit, canMove, moved, START, type Direction, type Point } from "./maze.ts";
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
  | { readonly action: "move"; readonly price: number; readonly direction: Direction }
  | { readonly action: "look" | "map"; readonly price: number };

interface RecordedMove {
  readonly action: "move";
  readonly price: number;
  readonly direction: Direction;
  /** False when the move hit a wall: charged for, but it advanced nothing. */
  readonly moved: boolean;
}
type RecordedAction = RecordedMove | { readonly action: "look" | "map"; readonly price: number };

export interface Run {
  readonly id: string;
  readonly roundId: RoundId;
  readonly payer: string;
  readonly startedAt: string;
  at: Point;
  actions: RecordedAction[];
  spentUsd: number;
  steps: number;
  outcome: Outcome;
  finishedAt: string | null;
}

/** The public shape: everything needed to check a run, and nothing a verifier can recompute. */
export interface PublishedRun {
  readonly id: string;
  readonly round: RoundId;
  readonly payer: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: Outcome;
  readonly steps: number;
  readonly spentUsd: number;
  readonly optimalSteps: number;
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
export class RunStore {
  readonly #runs = new Map<string, Run>();
  readonly #limit: number;

  constructor(limit = 10_000) {
    this.#limit = limit;
  }

  start(input: { roundId: RoundId; payer: string }): Run {
    const run: Run = {
      id: randomUUID(),
      roundId: input.roundId,
      payer: input.payer.toLowerCase(),
      startedAt: new Date().toISOString(),
      at: { ...START },
      actions: [],
      spentUsd: 0,
      steps: 0,
      outcome: "running",
      finishedAt: null,
    };
    this.#runs.set(run.id, run);
    this.#evictIfFull();
    return run;
  }

  get(id: string): Run | undefined {
    return this.#runs.get(id);
  }

  forRound(roundId: RoundId): readonly Run[] {
    return [...this.#runs.values()].filter((run) => run.roundId === roundId);
  }

  get size(): number {
    return this.#runs.size;
  }

  /**
   * Drop the oldest **finished** run when full, and never a running one.
   *
   * Evicting a run in progress would take an agent's paid-for maze away mid-step. Evicting a
   * finished one loses a leaderboard entry, which is why the limit is high and why anything that
   * has to outlive this — the reputation written on chain — carries its own copy rather than a
   * pointer into here.
   */
  #evictIfFull(): void {
    if (this.#runs.size <= this.#limit) return;
    for (const [id, run] of this.#runs) {
      if (run.outcome === "running") continue;
      this.#runs.delete(id);
      return;
    }
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
  if (entry.action === "move" && entry.moved) run.steps += 1;
  return run;
}

export const move = (run: Run, direction: Direction, didMove: boolean): Run =>
  record(run, { action: "move", price: PRICES.move, direction, moved: didMove });

export const look = (run: Run): Run => record(run, { action: "look", price: PRICES.look });
export const map = (run: Run): Run => record(run, { action: "map", price: PRICES.map });

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
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    steps: run.steps,
    spentUsd: run.spentUsd,
    optimalSteps: round(run.roundId).optimalSteps,
    actions: run.actions.map((entry) =>
      entry.action === "move"
        ? { action: "move", price: entry.price, direction: entry.direction }
        : { action: entry.action, price: entry.price }),
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
  return `0x${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

/**
 * Replay a published record against the maze its round implies.
 *
 * This is what a stranger runs. It takes nothing on trust: not the ending square, not the step
 * count, not the amount charged. A record that fails here is a claim we should not be publishing,
 * whether it failed because of a bug or because somebody edited it.
 */
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
