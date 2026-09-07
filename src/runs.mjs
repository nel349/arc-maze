import { createHash, randomUUID } from "node:crypto";
import { atExit, canMove, moved, START } from "./maze.mjs";
import { round } from "./round.mjs";

/**
 * What happened in a run, written down so somebody else can check it.
 *
 * A leaderboard nobody can audit is a leaderboard nobody should believe, and ours will eventually
 * claim things on chain — the reputation written when an agent solves a maze points at one of these
 * records and commits to its hash. So the record is not a log. It is the evidence.
 *
 * The maze is derived from the round id and the generator is deterministic, so a record needs to
 * carry only *what the agent did*. Anyone can rebuild the maze from the id, walk the actions, and
 * confirm three things independently of us: that every move was legal, that the run ended where it
 * claims, and that the total charged matches the actions taken. `verify` below is that check, and
 * it is the same code the server trusts — there is no privileged path that skips it.
 */

/** Prices in dollars, which is how they are decided and displayed. */
export const PRICES = { move: 0.001, look: 0.002, map: 0.01 };

const runs = new Map();

export function start({ roundId, payer }) {
  const run = {
    id: randomUUID(),
    roundId,
    payer: payer.toLowerCase(),
    startedAt: new Date().toISOString(),
    at: { ...START },
    actions: [],
    spentUsd: 0,
    steps: 0,
    outcome: "running",
    finishedAt: null,
  };
  runs.set(run.id, run);
  return run;
}

export const get = (id) => runs.get(id);

/**
 * Record one paid action.
 *
 * A run belongs to the round it started in, even after the hour turns. Cutting an agent off
 * mid-maze because a clock ticked would punish it for the round it happened to enter, and it has
 * already paid for the steps it took. It scores against its own round; it simply cannot start a new
 * run in an hour that has closed.
 */
export function record(run, action, detail = {}) {
  const price = PRICES[action];
  if (price === undefined) throw new Error(`no such action: ${action}`);
  run.actions.push({ action, price, ...detail });
  run.spentUsd = Number((run.spentUsd + price).toFixed(6));
  if (action === "move" && detail.moved) run.steps += 1;
  return run;
}

export function finish(run, outcome) {
  run.outcome = outcome;
  run.finishedAt = new Date().toISOString();
  return run;
}

/**
 * The public shape of a run: everything needed to check it, and nothing else.
 *
 * `at` is deliberately absent — position is derivable from the actions, and carrying it would let a
 * record disagree with itself. Anything a verifier can recompute is left out on purpose, because a
 * field that can drift is a field that will.
 */
export function published(run) {
  const { optimalSteps } = round(run.roundId);
  return {
    id: run.id,
    round: run.roundId,
    payer: run.payer,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    outcome: run.outcome,
    steps: run.steps,
    spentUsd: run.spentUsd,
    optimalSteps,
    actions: run.actions.map(({ action, price, direction }) =>
      direction ? { action, price, direction } : { action, price }),
  };
}

/**
 * A stable digest of a published record, for the on-chain reputation to commit to.
 *
 * Keys are sorted before hashing because JSON key order is an implementation detail and a hash that
 * depends on it is a hash that breaks when the serializer changes. Whatever we write on chain has
 * to be reproducible from the published record years later, by someone using a different language.
 */
export function digest(record) {
  const canonical = (value) => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
  };
  return `0x${createHash("sha256").update(canonical(record)).digest("hex")}`;
}

/**
 * Replay a published record against the maze its round implies.
 *
 * This is what a stranger runs. It takes nothing on trust: not the ending position, not the step
 * count, not the amount charged. A record that fails here is a claim we should not be publishing,
 * whether it failed because of a bug or because somebody edited it.
 */
export function verify(record) {
  const problems = [];
  const { cells } = round(record.round);
  let at = { ...START };
  let steps = 0;
  let spent = 0;

  for (const [i, entry] of record.actions.entries()) {
    const price = PRICES[entry.action];
    if (price === undefined) {
      problems.push(`action ${i}: unknown action ${entry.action}`);
      continue;
    }
    if (entry.price !== price) problems.push(`action ${i}: charged ${entry.price}, tariff is ${price}`);
    spent += price;

    if (entry.action !== "move") continue;
    if (!entry.direction) {
      problems.push(`action ${i}: a move with no direction`);
      continue;
    }
    // A move into a wall is a legal *purchase* — the agent paid to learn the wall was there — so it
    // costs money and changes nothing. Only a move that could actually happen advances the count.
    if (canMove(cells, at.x, at.y, entry.direction)) {
      at = moved(at.x, at.y, entry.direction);
      steps += 1;
    }
  }

  const total = Number(spent.toFixed(6));
  if (record.spentUsd !== total) problems.push(`spend says ${record.spentUsd}, actions total ${total}`);
  if (record.steps !== steps) problems.push(`steps says ${record.steps}, actions give ${steps}`);
  if (record.outcome === "solved" && !atExit(at.x, at.y)) {
    problems.push(`claims solved but the actions end at ${at.x},${at.y}`);
  }
  if (record.outcome !== "solved" && atExit(at.x, at.y)) {
    problems.push("reached the exit but is not recorded as solved");
  }
  return { ok: problems.length === 0, problems, endedAt: at, steps, spentUsd: total };
}

/** Everything from a round, for the boards. */
export function forRound(roundId) {
  return [...runs.values()].filter((r) => r.roundId === roundId);
}

export const all = () => [...runs.values()];
