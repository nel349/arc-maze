import { expect, test } from "bun:test";
import { feed, frame, heartbeat, type LiveEvent } from "../src/live/feed.ts";

const R = "2026-09-08T00";
const started = (run: string): LiveEvent => ({ kind: "started", round: R, run, at: { x: 0, y: 0 } });
const bought = (run: string, price = 0.001): LiveEvent =>
  ({ kind: "bought", round: R, run, action: "move", price, spentUsd: price, at: { x: 0, y: 1 }, batch: "b-1" });

test("a subscriber hears what is published after it arrives", () => {
  const live = feed();
  const heard: LiveEvent[] = [];
  live.subscribe((e) => heard.push(e));

  live.publish(started("a"));
  live.publish(bought("a"));

  expect(heard.map((e) => e.kind)).toEqual(["started", "bought"]);
});

test("everyone watching hears the same round", () => {
  const live = feed();
  const one: LiveEvent[] = []; const two: LiveEvent[] = [];
  live.subscribe((e) => one.push(e));
  live.subscribe((e) => two.push(e));

  live.publish(started("a"));

  expect(live.watching).toBe(2);
  expect(one).toEqual(two);
});

/**
 * The leak this guards. Every viewer that opens the stream adds a listener, and a page left open
 * on a phone that goes to sleep never says goodbye politely — the abort handler is what removes
 * it, and if unsubscribing did not work the process would accumulate one listener per visit
 * forever.
 */
test("unsubscribing stops delivery, and twice is harmless", () => {
  const live = feed();
  const heard: LiveEvent[] = [];
  const stop = live.subscribe((e) => heard.push(e));

  live.publish(started("a"));
  stop();
  live.publish(bought("a"));
  stop();

  expect(heard).toHaveLength(1);
  expect(live.watching).toBe(0);
});

/**
 * A viewer leaving is the ordinary case, not an exception: writing to a closed connection throws,
 * and that happens while the set is being iterated. Publishing must survive it, and everyone else
 * must still get the event.
 */
test("one viewer breaking does not stop the round for the others", () => {
  const live = feed();
  const heard: LiveEvent[] = [];

  const stop = live.subscribe(() => { throw new Error("connection closed"); });
  live.subscribe((e) => heard.push(e));

  expect(() => live.publish(started("a"))).not.toThrow();
  expect(heard).toHaveLength(1);
  stop();
});

test("a listener that unsubscribes while being notified does not corrupt the delivery", () => {
  const live = feed();
  const heard: string[] = [];
  const stop = live.subscribe(() => { heard.push("first"); stop(); });
  live.subscribe(() => heard.push("second"));

  live.publish(started("a"));

  expect(heard).toEqual(["first", "second"]);
  expect(live.watching).toBe(1);
});

// ---- the wire format ---------------------------------------------------------

test("a frame names its kind and ends with the blank line that dispatches it", () => {
  const wire = frame(bought("a"));
  expect(wire.startsWith("event: bought\ndata: {")).toBe(true);
  expect(wire.endsWith("\n\n")).toBe(true);
  expect(JSON.parse(wire.split("data: ")[1] ?? "")).toMatchObject({ run: "a", action: "move" });
});

test("the payload says which batch accepted it, never that it settled", () => {
  const wire = frame(bought("a"));
  const payload: unknown = JSON.parse(wire.split("data: ")[1] ?? "");
  expect(payload).toHaveProperty("batch");
  expect(JSON.stringify(payload)).not.toContain("settled");
});

test("a heartbeat is a comment, so it cannot be mistaken for an event", () => {
  expect(heartbeat().startsWith(":")).toBe(true);
  expect(heartbeat()).not.toContain("event:");
  expect(heartbeat().endsWith("\n\n")).toBe(true);
});
