import { generate, shortestPath, type Direction, type Maze } from "./grid.ts";

/**
 * A round, which is an hour and the maze that belongs to it.
 *
 * Everyone racing the same maze is what makes two runs comparable, and deriving that maze from the
 * clock is what makes it checkable. The round id *is* the hour, the maze is seeded from the id, and
 * the generator is deterministic — so anyone can recompute this round's maze from nothing but the
 * time, and confirm we did not hand somebody an easier one.
 *
 * That property is worth more than it looks. Two independent copies of this server serve identical
 * rounds with no coordination, and a leaderboard can be audited by a stranger who does not trust
 * us. The alternative — a maze we generate and remember — asks everyone to take our word for it,
 * which is exactly what a competition cannot afford.
 *
 * An hour, because a demo has to fit inside one and a losing agent should get another go the same
 * afternoon.
 */

const HOUR_MS = 60 * 60 * 1000;

/** `2026-09-07T00` — the hour and nothing finer. Sortable, readable, and its own seed. */
export type RoundId = string;

const ROUND_ID = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

export const isRoundId = (value: unknown): value is RoundId =>
  typeof value === "string" && ROUND_ID.test(value);

export interface Round {
  readonly id: RoundId;
  readonly cells: Maze;
  /** The best possible run, so a board can say how close to perfect a solve was. */
  readonly optimalSteps: number;
  readonly optimalRoute: readonly Direction[];
  readonly openedAt: Date;
  readonly closesAt: Date;
}

export const roundIdAt = (when: Date = new Date()): RoundId =>
  when.toISOString().slice(0, 13);

export const openedAt = (id: RoundId): Date => new Date(`${id}:00:00.000Z`);

export const closesAt = (id: RoundId): Date => new Date(openedAt(id).getTime() + HOUR_MS);

/**
 * Rounds are built on demand and cached, never scheduled.
 *
 * Nothing has to tick. Asking for the current round at 00:59 and again at 01:00 simply produces two
 * different ids, so there is no timer to drift, nothing to miss if the process restarts mid-hour,
 * and no window in which a round exists but its maze does not.
 */
const built = new Map<RoundId, Round>();

/** A day of mazes is more than any page or replay needs, and bounds a long-lived process. */
const KEEP = 24;

export function round(id: RoundId = roundIdAt()): Round {
  const existing = built.get(id);
  if (existing) return existing;
  if (!isRoundId(id)) throw new Error(`not a round id: ${id}`);

  const cells = generate(id);
  const optimalRoute = shortestPath(cells);
  if (optimalRoute === null) {
    // Unreachable for a perfect maze; if it ever fires, the generator is broken and every run in
    // this round would be unwinnable. Better to refuse the round than to sell steps into it.
    throw new Error(`round ${id} generated a maze with no route to the exit`);
  }

  const value: Round = {
    id,
    cells,
    optimalSteps: optimalRoute.length,
    optimalRoute,
    openedAt: openedAt(id),
    closesAt: closesAt(id),
  };
  built.set(id, value);
  if (built.size > KEEP) {
    const oldest = built.keys().next();
    if (!oldest.done) built.delete(oldest.value);
  }
  return value;
}

export const isOpen = (id: RoundId, now: Date = new Date()): boolean => roundIdAt(now) === id;

/**
 * When the game went live. Rounds before it never happened; rounds after it always exist.
 *
 * A **fixed** date, not the round the process happened to boot in. That was the default, and it
 * quietly contradicted the rule two comments below: every restart moved the horizon to now, so
 * every link shared before the restart answered 404 — which is precisely the failure the rule
 * exists to prevent, and the one that matters most for a project whose distribution *is* the link.
 *
 * Nothing is lost by reaching back: a maze is derived from its round id, so any past round can be
 * rebuilt and replayed. Only the run history is in memory, and that was never durable.
 */
const GENESIS: RoundId = "2026-09-01T00";

/**
 * Read defensively, because this module is imported somewhere `process` does not exist.
 *
 * The enclave that re-executes a run needs `round()` to rebuild the maze, and it runs the module as
 * plain JavaScript compiled to WASM. A bare `process.env` there is a ReferenceError at import time,
 * which takes the whole module down before anything is called.
 */
export const FIRST_ROUND: RoundId =
  (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.["FIRST_ROUND"] ?? GENESIS;

export interface ExistsOptions {
  readonly firstRound?: RoundId;
  readonly now?: number;
}

/**
 * Whether a round exists at all, which is not the same as being open.
 *
 * A finished round has to stay readable — its link is already out in the world, and a shared card
 * that becomes a 404 an hour later is worse than one that was never shared. Rounds before the game
 * existed are a different matter, and are refused rather than invented.
 */
export function exists(id: RoundId, options: ExistsOptions = {}): boolean {
  const { firstRound = FIRST_ROUND, now = Date.now() } = options;
  if (!isRoundId(id)) return false;
  const at = openedAt(id).getTime();
  return Number.isFinite(at) && at >= openedAt(firstRound).getTime() && at <= now;
}
