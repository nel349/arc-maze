import { expect, test } from "bun:test";
import { round } from "../src/maze/index.ts";
import {
  digest, finish, look, map, move, published, RunStore, verify,
  type PublishedRun,
} from "../src/maze/index.ts";

const ROUND = "2026-09-07T00";
const PAYER = "0x1111111111111111111111111111111111111111";

/** A fresh store per test, so no test can depend on the ones before it. */
const start = (): ReturnType<RunStore["start"]> =>
  new RunStore().start({ roundId: ROUND, payer: PAYER });

/** Walk the known-best route, recording each move as the server would. */
function solved() {
  const run = start();
  for (const direction of round(ROUND).optimalRoute) move(run, direction, true);
  return published(finish(run, "solved"));
}

test("a real solve verifies", () => {
  const result = verify(solved());
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.steps).toBe(round(ROUND).optimalSteps);
});

test("the charge matches the actions", () => {
  const record = solved();
  expect(record.spentUsd).toBe(Number((record.steps * 0.001).toFixed(6)));
});

test("a tampered total is caught", () => {
  const cheaper: PublishedRun = { ...solved(), spentUsd: 0.001 };
  expect(verify(cheaper).ok).toBe(false);
  expect(verify(cheaper).problems.join(" ")).toMatch(/spend says/);
});

test("claiming a solve you did not reach is caught", () => {
  const run = start();
  move(run, round(ROUND).optimalRoute[0]!, true);
  const lie = published(finish(run, "solved"));
  expect(verify(lie).ok).toBe(false);
  expect(verify(lie).problems.join(" ")).toMatch(/claims solved/);
});

test("a step quietly removed from the middle is caught", () => {
  const record = solved();
  const actions = record.actions.filter((_, i) => i !== 3);
  const shortened: PublishedRun = {
    ...record,
    actions,
    steps: actions.length,
    spentUsd: Number((actions.length * 0.001).toFixed(6)),
  };
  expect(verify(shortened).ok).toBe(false);
});

test("walking into a wall costs money and gets you nowhere", () => {
  const run = start();
  // North from the start cell is the outside of the maze, so it can never be open.
  move(run, "n", false);
  const result = verify(published(finish(run, "gave-up")));
  expect(result.problems).toEqual([]);
  expect(result.steps).toBe(0);
  expect(result.spentUsd).toBe(0.001);
});

test("looking and buying the map cost what the tariff says", () => {
  const run = start();
  look(run);
  map(run);
  expect(published(run).spentUsd).toBe(0.012);
  expect(verify(published(finish(run, "gave-up"))).ok).toBe(true);
});

test("the digest ignores key order, or the chain commits to a moving target", () => {
  const record = solved();
  const reordered = Object.fromEntries(Object.entries(record).reverse());
  expect(digest(record)).toBe(digest(reordered));
});

test("the digest changes when the record does", () => {
  const record = solved();
  expect(digest(record)).not.toBe(digest({ ...record, steps: record.steps + 1 }));
});

test("a published run carries no position, since anything derivable can drift", () => {
  expect("at" in solved()).toBe(false);
});

test("the store bounds itself rather than growing until the process dies", () => {
  const store = new RunStore(3);
  for (let i = 0; i < 5; i++) {
    finish(store.start({ roundId: ROUND, payer: PAYER }), "gave-up");
  }
  expect(store.size).toBeLessThanOrEqual(3);
});

test("eviction never takes a maze away from an agent mid-step", () => {
  const store = new RunStore(2);
  const running = store.start({ roundId: ROUND, payer: PAYER });
  // Fill well past the limit with finished runs; the live one must survive all of it.
  for (let i = 0; i < 10; i++) {
    finish(store.start({ roundId: ROUND, payer: PAYER }), "gave-up");
  }
  expect(store.get(running.id)).toBeDefined();
  expect(store.get(running.id)?.outcome).toBe("running");
});

test("a round's runs are the ones that started in it", () => {
  const store = new RunStore();
  store.start({ roundId: ROUND, payer: PAYER });
  store.start({ roundId: "2026-09-07T01", payer: PAYER });
  expect(store.forRound(ROUND)).toHaveLength(1);
  expect(store.forRound("2026-09-07T01")).toHaveLength(1);
});
