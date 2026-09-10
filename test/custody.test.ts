import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Which key goes to which constructor — a structural test, for a bug no unit test could catch.
 *
 * The defect this exists to prevent had already shipped. `server.ts` read one environment variable
 * and handed the same key to both the reputation writer and the badge registrar, while the comment
 * directly above it said "the key that writes reputation, which is not the key anything else uses".
 * The code was correct everywhere it was tested: the scribe wrote reputation, the registrar minted
 * badges, and both did exactly what their tests asked. What was wrong was the wiring, and the
 * wiring is not a function anybody can call.
 *
 * The consequence was that a host we do not own held the badge contract's owner key — the one key
 * that can mint every remaining place, repoint every badge's art, and give the contract away — in
 * order to do a job that needs none of those powers.
 *
 * So what is asserted here is custody: that the two keys are read from two variables, that the
 * privileged one is refused outright, and that neither is passed to the wrong constructor.
 */

const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");
const badge = readFileSync(new URL("../src/arc/badge.ts", import.meta.url), "utf8");

test("reputation and minting are read from two different environment variables", () => {
  expect(server).toContain('process.env["MAZE_REPUTATION_KEY"]');
  expect(server).toContain('process.env["MAZE_ADMITTER_KEY"]');
});

/**
 * The exact shape of the original bug: one key reaching both constructors.
 *
 * Written against the call sites rather than the variable names, because renaming the variable is
 * the easiest way to reintroduce this while looking like a tidy-up.
 */
test("the reputation key never reaches the registrar, and the admitter key never signs feedback", () => {
  const call = (fn: string): string => {
    const at = server.indexOf(`${fn}(`);
    expect(at).toBeGreaterThan(0);
    return server.slice(at, server.indexOf(")", at) + 1);
  };

  expect(call("scribe")).toContain("writingKey");
  expect(call("scribe")).not.toContain("admitterKey");

  expect(call("registrar")).toContain("admitterKey");
  expect(call("registrar")).not.toContain("writingKey");
});

/**
 * The old variable held the owner key, so a deployment still carrying it is still exposed.
 *
 * Refused rather than ignored: quietly not using it would leave the owner key sitting in an
 * environment nobody has a reason to revisit, which is the state this whole change exists to end.
 */
test("the old single-key variable is refused, not ignored", () => {
  expect(server).toContain('process.env["MAZE_PRIVATE_KEY"] !== undefined');
  const at = server.indexOf('process.env["MAZE_PRIVATE_KEY"]');
  expect(server.slice(at, at + 400)).toContain("throw new Error");
});

/**
 * The count that keeps the promise honest.
 *
 * "Neither key owns anything" is only true while there are exactly two of them. A third
 * `process.env[...KEY]` in here is a third custody question nobody has asked.
 */
test("the server reads exactly two private keys", () => {
  const keys = server.match(/process\.env\["[A-Z_]*KEY[A-Z_]*"\]/g) ?? [];
  expect(new Set(keys)).toEqual(new Set([
    'process.env["MAZE_REPUTATION_KEY"]',
    'process.env["MAZE_ADMITTER_KEY"]',
    'process.env["MAZE_PRIVATE_KEY"]',
  ]));
});

/**
 * Reading how full the cohort is must not require a key.
 *
 * This is what lets the front page keep its plate on a deployment that cannot mint — including one
 * where the owner has deliberately pointed the admitter at nobody. If `roster` ever grows a key
 * parameter, the page and the mint are welded back together and the split starts leaking back.
 */
test("the public count is readable without any key at all", () => {
  const at = badge.indexOf("export function roster(");
  expect(at).toBeGreaterThan(0);
  const signature = badge.slice(at, badge.indexOf("{", at));
  expect(signature).not.toContain("privateKey");
  expect(signature).toContain("contract: Address");

  // And the minting half still takes one, or the separation is decorative.
  const minting = badge.slice(badge.indexOf("export function registrar("));
  expect(minting.slice(0, minting.indexOf("{"))).toContain("privateKey");
});

// ---- what a key has to look like before anything signs with it ---------------------------------

import { asAddress, asPrivateKey } from "../src/arc/chain.ts";

test("a key that is not a key is refused, and so is an address in its place", () => {
  const good = `0x${"a".repeat(64)}`;
  expect(asPrivateKey("K", good)).toBe(good as `0x${string}`);

  for (const bad of [
    "",
    "0x",
    `0x${"a".repeat(63)}`,           // one short — a truncated paste
    `0x${"a".repeat(65)}`,
    `0x${"a".repeat(64)}\n`,         // a trailing newline, which is what a here-doc leaves behind
    `${"a".repeat(64)}`,             // no 0x
    `0x${"z".repeat(64)}`,           // not hex
    `0x${"a".repeat(40)}`,           // an address in the key's slot
  ]) {
    expect(() => asPrivateKey("K", bad)).toThrow();
  }
});

test("an address is checked at its own length, not a key's", () => {
  const good = `0x${"b".repeat(40)}`;
  expect(asAddress("A", good)).toBe(good as `0x${string}`);
  expect(() => asAddress("A", `0x${"b".repeat(64)}`)).toThrow();
  expect(() => asAddress("A", `0x${"b".repeat(39)}`)).toThrow();
});

/**
 * The one assertion here that is about secrets rather than shapes.
 *
 * A rejected key is still a key. If the message quoted what it was given, the fastest route from a
 * mistyped environment variable to a private key sitting in a log aggregator would be this function
 * doing its job. The name and the expected shape are all anyone needs to fix it.
 */
test("a refusal never quotes the value it refused", () => {
  const secret = `0x${"c".repeat(63)}`;
  try {
    asPrivateKey("MAZE_ADMITTER_KEY", secret);
    throw new Error("should have refused");
  } catch (cause) {
    const message = (cause as Error).message;
    expect(message).toContain("MAZE_ADMITTER_KEY");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("ccc");
  }
});
