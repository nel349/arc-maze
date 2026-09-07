import { expect, test } from "bun:test";
import { closesAt, exists, isOpen, openedAt, round, roundIdAt } from "../src/maze/index.ts";
import { generate } from "../src/maze/index.ts";

/**
 * The round is derived from the clock and the maze from the round, which is what lets a stranger
 * recompute both and audit a leaderboard without trusting us. These tests are that claim.
 */

const FIXED = { firstRound: "2026-09-01T00", now: new Date("2026-09-07T13:30:00Z").getTime() };

test("the same hour always produces the same maze", () => {
  expect(round("2026-09-07T00").cells).toEqual(round("2026-09-07T00").cells);
  expect(round("2026-09-07T00").optimalSteps).toBe(round("2026-09-07T00").optimalSteps);
});

test("a different hour produces a different maze, or everyone races yesterday's", () => {
  expect(round("2026-09-07T00").cells).not.toEqual(round("2026-09-07T01").cells);
});

test("a maze rebuilt from nothing but the id matches the one we served", () => {
  // The audit a stranger performs: seed the generator with the id, compare.
  expect(generate("2026-09-07T05")).toEqual(round("2026-09-07T05").cells);
});

test("every hour of a day is solvable, so nobody pays into a maze with no way out", () => {
  for (let hour = 0; hour < 24; hour++) {
    const id = `2026-09-07T${String(hour).padStart(2, "0")}`;
    expect(round(id).optimalSteps).toBeGreaterThan(0);
  }
});

test("an hour is an hour", () => {
  expect(openedAt("2026-09-07T13").toISOString()).toBe("2026-09-07T13:00:00.000Z");
  expect(closesAt("2026-09-07T13").toISOString()).toBe("2026-09-07T14:00:00.000Z");
  expect(roundIdAt(new Date("2026-09-07T13:59:59.999Z"))).toBe("2026-09-07T13");
  expect(roundIdAt(new Date("2026-09-07T14:00:00.000Z"))).toBe("2026-09-07T14");
});

test("open means now, and a closed round is still a real round", () => {
  const now = new Date("2026-09-07T13:30:00Z");
  expect(isOpen("2026-09-07T13", now)).toBe(true);
  expect(isOpen("2026-09-07T12", now)).toBe(false);
  // Closed is not gone: the link is already out in the world.
  expect(exists("2026-09-07T12", FIXED)).toBe(true);
});

test("a round that never happened is refused rather than invented", () => {
  expect(exists("not-a-round", FIXED)).toBe(false);
  expect(exists("2027-01-01T00", FIXED)).toBe(false);
  expect(exists("2020-01-01T00", FIXED)).toBe(false);
});

test("an unparseable id is refused by round() rather than seeding a maze from nonsense", () => {
  expect(() => round("nonsense")).toThrow(/not a round id/);
});
