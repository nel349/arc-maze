import { expect, test } from "bun:test";
import { closesAt, exists, FIRST_ROUND, isOpen, openedAt, round, roundIdAt } from "../src/maze/index.ts";
import { generate } from "../src/maze/index.ts";

/**
 * The round is derived from the clock and the maze from the round, which is what lets a stranger
 * recompute both and audit a leaderboard without trusting us. These tests are that claim.
 */

const FIXED = { firstRound: "2026-09-01T00", now: new Date("2026-09-07T13:30:00Z").getTime() };

test("the same hour always produces the same maze", () => {
  // Asked of the generator, not of `round`. `round` caches, so comparing two of its results
  // compares one object with itself and would agree even if generation were random.
  expect(generate("2026-09-07T00")).toEqual(generate("2026-09-07T00"));
});

test("and the round is built once, so a replay reads the same maze the run was sold", () => {
  expect(round("2026-09-07T02")).toBe(round("2026-09-07T02"));
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

/**
 * The horizon must not move when the process restarts. It used to: FIRST_ROUND defaulted to the
 * round the server booted in, so every link shared before a restart answered 404 — the exact
 * failure `exists` is documented to prevent, in a project where the link is the product.
 */
test("a round shared yesterday still exists today, whatever time the server started", () => {
  const now = Date.UTC(2026, 8, 8, 14);
  const yesterday = roundIdAt(new Date(now - 24 * 60 * 60 * 1000));

  expect(exists(yesterday, { now })).toBe(true);
  expect(exists(roundIdAt(new Date(now)), { now })).toBe(true);
});

test("but a round from before the game existed is still refused, not invented", () => {
  const now = Date.UTC(2026, 8, 8, 14);
  expect(exists("2026-08-31T23", { now })).toBe(false);
  expect(exists("2020-01-01T00", { now })).toBe(false);
});

test("and a round that has not happened yet does not exist either", () => {
  const now = Date.UTC(2026, 8, 8, 14);
  expect(exists(roundIdAt(new Date(now + 60 * 60 * 1000)), { now })).toBe(false);
});

/**
 * The horizon is inclusive, and the first round is the one most likely to be linked.
 *
 * `>=` becoming `>` here excludes the genesis hour itself — the round every early link points at —
 * and every one of those links becomes a 404 while every other round keeps working, which is
 * exactly the shape of failure nobody notices until somebody else reports it. Stated with an
 * explicit `firstRound` so an env override cannot make this test about a different hour.
 */
test("the first round that ever existed exists, and the hour before it does not", () => {
  const first = "2026-09-01T00";
  const now = openedAt("2026-09-07T13").getTime();
  expect(exists(first, { firstRound: first, now })).toBe(true);
  expect(exists("2026-08-31T23", { firstRound: first, now })).toBe(false);
});

test("a round that has not happened yet does not exist either", () => {
  const now = openedAt("2026-09-07T13").getTime();
  expect(exists("2026-09-07T13", { firstRound: FIRST_ROUND, now })).toBe(true);
  expect(exists("2026-09-07T14", { firstRound: FIRST_ROUND, now })).toBe(false);
});
