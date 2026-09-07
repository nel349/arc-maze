import { published, type PublishedRun, type Run } from "./runs.ts";
import { round, type RoundId } from "./round.ts";

/**
 * Two leaderboards, because they reward opposite play.
 *
 * **Fewest steps** rewards racing: buy the map, sprint, damn the cost. **Least spent** rewards
 * thinking: feel your way and pay for nothing you did not need. One maze, two ways to be best, and
 * no agent tops both — buying the map costs the price of ten steps, so the agent that wins the race
 * is usually nowhere on the efficiency board.
 *
 * That is the whole reason there are two. A single board would collapse the interesting decision
 * into a stopwatch and reward whoever spent the most.
 *
 * **What these boards do not claim.** A solve is *claimed* the moment an agent leaves the maze;
 * Circle batches the payments behind it about a quarter of an hour later. Every entry here is
 * therefore a claim, and says so — `settlements` counts the payments the facilitator has accepted
 * into a batch, which is not the same as a batch that has landed. Publishing the first as the
 * second is the failure #31 exists to avoid.
 */

export type BoardKind = "fewest-steps" | "least-spent";

export interface Entry {
  readonly rank: number;
  readonly run: string;
  readonly payer: string | null;
  readonly steps: number;
  readonly spentUsd: number;
  /** How far off perfect: 0 means it walked the shortest route there is. */
  readonly overOptimal: number;
  readonly finishedAt: string | null;
  /** Payments the facilitator accepted into a batch. Not proof a batch has settled on chain. */
  readonly settlements: number;
}

export interface Board {
  readonly kind: BoardKind;
  readonly of: RoundId | "all-time";
  /** Every entry here is a claim, not a settled fact. See the note above. */
  readonly basis: "claimed";
  readonly entries: readonly Entry[];
  /** Runs that did not get out, shown because a board of only winners hides the interesting half. */
  readonly unfinished: readonly Entry[];
}

const settlementsIn = (run: PublishedRun): number =>
  run.actions.filter((action) => action.settlement !== undefined).length;

function entry(run: PublishedRun, rank: number): Entry {
  return {
    rank,
    run: run.id,
    payer: run.payer,
    steps: run.steps,
    spentUsd: run.spentUsd,
    overOptimal: run.steps - run.optimalSteps,
    finishedAt: run.finishedAt,
    settlements: settlementsIn(run),
  };
}

/**
 * Ties break by who finished first.
 *
 * Two agents that solve a maze in the same number of steps for the same money have played equally
 * well, and something has to separate them. Arrival is the only tiebreak that is not arbitrary —
 * and unlike ranking by chance it cannot be gamed, because the earlier agent genuinely got there
 * first. A run with no finish time sorts last; it has not finished.
 */
const arrivedFirst = (a: PublishedRun, b: PublishedRun): number =>
  (a.finishedAt ?? "￿").localeCompare(b.finishedAt ?? "￿");

const COMPARE: Readonly<Record<BoardKind, (a: PublishedRun, b: PublishedRun) => number>> = {
  "fewest-steps": (a, b) => a.steps - b.steps || arrivedFirst(a, b),
  "least-spent": (a, b) => a.spentUsd - b.spentUsd || arrivedFirst(a, b),
};

/**
 * Rank the solved runs, and list the rest.
 *
 * Only a run that reached the exit can be ranked — an agent that gave up after two steps has not
 * "spent least", it has failed cheaply, and putting it top of the efficiency board would make that
 * board a joke. The unfinished are still listed, because the runs that ran out of allowance three
 * cells from the exit are the ones worth looking at.
 */
export function board(kind: BoardKind, runs: readonly Run[], of: RoundId | "all-time"): Board {
  const records = runs.map(published);
  const solved = records.filter((run) => run.outcome === "solved").sort(COMPARE[kind]);
  const rest = records
    .filter((run) => run.outcome !== "solved")
    .sort((a, b) => b.spentUsd - a.spentUsd);

  return {
    kind,
    of,
    basis: "claimed",
    entries: solved.map((run, i) => entry(run, i + 1)),
    unfinished: rest.map((run, i) => entry(run, i + 1)),
  };
}

export interface RoundBoards {
  readonly round: RoundId;
  readonly optimalSteps: number;
  readonly boards: readonly Board[];
}

/** Both boards for one round, which is what a round page and an unfurled card need. */
export const boardsFor = (roundId: RoundId, runs: readonly Run[]): RoundBoards => ({
  round: roundId,
  optimalSteps: round(roundId).optimalSteps,
  boards: [board("fewest-steps", runs, roundId), board("least-spent", runs, roundId)],
});
