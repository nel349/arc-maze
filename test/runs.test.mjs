import { test } from "node:test";
import assert from "node:assert/strict";
import { digest, finish, published, record, start, verify } from "../src/runs.mjs";
import { round } from "../src/round.mjs";

const ROUND = "2026-09-07T00";
const PAYER = "0x1111111111111111111111111111111111111111";

/** Walk the known-best route, recording each move as the server would. */
function solve() {
  const { optimalRoute } = round(ROUND);
  const run = start({ roundId: ROUND, payer: PAYER });
  for (const direction of optimalRoute) record(run, "move", { direction, moved: true });
  return finish(run, "solved");
}

test("a real solve verifies", () => {
  const result = verify(published(solve()));
  assert.ok(result.ok, result.problems.join("; "));
  assert.equal(result.steps, round(ROUND).optimalSteps);
});

test("the charge matches the actions, and a tampered total is caught", () => {
  const record_ = published(solve());
  assert.equal(record_.spentUsd, Number((record_.steps * 0.001).toFixed(6)));

  const cheaper = { ...record_, spentUsd: 0.001 };
  assert.equal(verify(cheaper).ok, false);
  assert.match(verify(cheaper).problems.join(" "), /spend says/);
});

test("claiming a solve you did not reach is caught", () => {
  const run = start({ roundId: ROUND, payer: PAYER });
  record(run, "move", { direction: round(ROUND).optimalRoute[0], moved: true });
  const lie = published(finish(run, "solved"));
  assert.equal(verify(lie).ok, false);
  assert.match(verify(lie).problems.join(" "), /claims solved/);
});

test("an invented step is caught, because the maze says where the walls are", () => {
  const record_ = published(solve());
  // Drop a move from the middle: the remaining route no longer reaches the exit.
  const shortened = { ...record_, actions: record_.actions.filter((_, i) => i !== 3) };
  assert.equal(verify({ ...shortened, steps: shortened.actions.length, spentUsd: Number((shortened.actions.length * 0.001).toFixed(6)) }).ok, false);
});

test("walking into a wall costs money and gets you nowhere", () => {
  const run = start({ roundId: ROUND, payer: PAYER });
  // North from the start cell is the outside of the maze, so it can never be open.
  record(run, "move", { direction: "n", moved: false });
  const record_ = published(finish(run, "gave-up"));
  const result = verify(record_);
  assert.ok(result.ok, result.problems.join("; "));
  assert.equal(result.steps, 0, "a refused move must not advance the step count");
  assert.equal(result.spentUsd, 0.001, "but it is still charged for");
});

test("looking and buying the map cost what the tariff says", () => {
  const run = start({ roundId: ROUND, payer: PAYER });
  record(run, "look");
  record(run, "map");
  assert.equal(published(run).spentUsd, 0.012);
  assert.ok(verify(published(finish(run, "gave-up"))).ok);
});

test("the digest does not depend on key order, or the chain would commit to a moving target", () => {
  const record_ = published(solve());
  const reordered = Object.fromEntries(Object.entries(record_).reverse());
  assert.equal(digest(record_), digest(reordered));
});

test("the digest changes when the record does", () => {
  const record_ = published(solve());
  assert.notEqual(digest(record_), digest({ ...record_, steps: record_.steps + 1 }));
});

test("a run carries no position, since anything derivable can drift", () => {
  assert.equal(published(solve()).at, undefined);
});
