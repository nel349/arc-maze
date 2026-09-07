import { test } from "node:test";
import assert from "node:assert/strict";
import { closesAt, exists, isOpen, openedAt, round, roundIdAt } from "../src/round.mjs";

/**
 * The round is derived from the clock and the maze from the round, which is what lets a stranger
 * recompute both and check a leaderboard without trusting us. These tests are that claim.
 */

test("the same hour always produces the same maze", () => {
  const a = round("2026-09-07T00");
  const b = round("2026-09-07T00");
  assert.deepEqual(a.cells, b.cells);
  assert.equal(a.optimalSteps, b.optimalSteps);
});

test("a different hour produces a different maze, or everyone races yesterday's", () => {
  const a = round("2026-09-07T00");
  const b = round("2026-09-07T01");
  assert.notDeepEqual(a.cells, b.cells);
});

test("a maze rebuilt from nothing but the id matches the one we served", async () => {
  // The audit a stranger performs: import the generator, seed it with the id, compare.
  const { generate } = await import("../src/maze.mjs");
  assert.deepEqual(generate("2026-09-07T05"), round("2026-09-07T05").cells);
});

test("every round is solvable, so nobody pays to enter a maze with no way out", () => {
  for (let hour = 0; hour < 24; hour++) {
    const id = `2026-09-07T${String(hour).padStart(2, "0")}`;
    assert.ok(round(id).optimalSteps > 0, `${id} has no route to the exit`);
  }
});

test("an hour is an hour", () => {
  const id = "2026-09-07T13";
  assert.equal(openedAt(id).toISOString(), "2026-09-07T13:00:00.000Z");
  assert.equal(closesAt(id).toISOString(), "2026-09-07T14:00:00.000Z");
  assert.equal(roundIdAt(new Date("2026-09-07T13:59:59.999Z")), id);
  assert.equal(roundIdAt(new Date("2026-09-07T14:00:00.000Z")), "2026-09-07T14");
});

test("open means now, and a closed round is still a real round", () => {
  const now = new Date("2026-09-07T13:30:00Z");
  assert.equal(isOpen("2026-09-07T13", now), true);
  assert.equal(isOpen("2026-09-07T12", now), false);
  // Closed is not gone: the link is already out in the world.
  assert.equal(exists("2026-09-07T12", { firstRound: "2026-09-01T00", now: now.getTime() }), true);
});

test("a round that never happened is refused rather than invented", () => {
  assert.equal(exists("not-a-round"), false);
  const now = new Date("2026-09-07T13:30:00Z").getTime();
  assert.equal(exists("2027-01-01T00", { firstRound: "2026-09-01T00", now }), false, "the future has no results");
  assert.equal(exists("2020-01-01T00", { firstRound: "2026-09-01T00", now }), false, "nor does before the game existed");
});
