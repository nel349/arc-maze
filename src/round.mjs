import { generate, shortestPath } from "./maze.mjs";

/**
 * A round, which is an hour and the maze that belongs to it.
 *
 * Everyone racing the same maze is what makes two runs comparable, and deriving that maze from the
 * clock is what makes it checkable. The round id *is* the hour, the maze is seeded from the id, and
 * the generator is deterministic — so anyone can recompute this round's maze from nothing but the
 * time, and confirm we did not hand somebody an easier one.
 *
 * That property is worth more than it looks. It means two independent copies of this server would
 * serve identical rounds with no coordination, and it means a leaderboard can be audited by a
 * stranger who does not trust us. The alternative — a maze we generate and remember — asks everyone
 * to take our word for it, which is exactly what a competition cannot afford.
 *
 * An hour because a demo has to fit inside one, and because a losing agent should get another go
 * the same afternoon.
 */

const HOUR_MS = 60 * 60 * 1000;

/** `2026-09-07T00` — the hour, and nothing finer. Sortable, readable, and its own seed. */
export function roundIdAt(when = new Date()) {
  return new Date(when).toISOString().slice(0, 13);
}

export function openedAt(roundId) {
  return new Date(`${roundId}:00:00.000Z`);
}

export function closesAt(roundId) {
  return new Date(openedAt(roundId).getTime() + HOUR_MS);
}

/**
 * Rounds are built on demand and cached, never scheduled.
 *
 * Nothing has to tick. Asking for the current round at 00:59 and again at 01:00 simply produces two
 * different ids, so there is no timer to drift, nothing to miss if the process restarts mid-hour,
 * and no window where a round exists but its maze does not.
 */
const built = new Map();

export function round(roundId = roundIdAt()) {
  const existing = built.get(roundId);
  if (existing) return existing;

  const cells = generate(roundId);
  const optimal = shortestPath(cells);
  const value = {
    id: roundId,
    cells,
    /** The best possible run, so a board can say how close to perfect a solve was. */
    optimalSteps: optimal.length,
    optimalRoute: optimal,
    openedAt: openedAt(roundId),
    closesAt: closesAt(roundId),
  };
  built.set(roundId, value);
  // Rounds are small and an hour apart, but a long-running process should not keep every maze it
  // has ever built. A day is more than any page or replay needs.
  if (built.size > 24) built.delete(built.keys().next().value);
  return value;
}

export const isOpen = (roundId, now = new Date()) => roundIdAt(now) === roundId;

/**
 * Whether a round exists at all, which is not the same as being open.
 *
 * A finished round has to stay readable — its link is already out in the world, and a shared card
 * that becomes a 404 an hour later is worse than one that was never shared. Rounds before the game
 * existed are a different matter and should be refused rather than invented.
 */
export function exists(roundId, { firstRound = FIRST_ROUND, now = Date.now() } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(roundId)) return false;
  const at = openedAt(roundId).getTime();
  return Number.isFinite(at) && at >= openedAt(firstRound).getTime() && at <= now;
}

/** Set once, when the game goes live: rounds before this never happened. */
export const FIRST_ROUND = process.env.FIRST_ROUND ?? roundIdAt();
