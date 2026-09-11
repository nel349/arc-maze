import { expect, test } from "bun:test";
import { upstash, type Send } from "../src/archive.ts";

/**
 * The wire, checked without a wire.
 *
 * These are about the request this sends and the reply it believes, which is the half the contract
 * tests in `store.test.ts` cannot reach: those check that the real store behaves, and pass only if
 * the replies are read correctly, but a reply that reads as success when it is a failure is exactly
 * the kind of thing a working store never shows you.
 *
 * No socket is bound: a test that has to listen on a port fails on a busy machine and leaves a
 * listener behind when it crashes. `fetch` is handed in instead.
 */

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A `Send` that remembers what it was asked and answers with whatever the test says. */
function recording(answer: () => Response) {
  const seen: { readonly url: string; readonly init: RequestInit | undefined }[] = [];
  const send: Send = async (url, init) => {
    seen.push({ url, init });
    return answer();
  };
  return { send, seen };
}

test("a command travels as a JSON array in the body, with the token in a header", async () => {
  const { send, seen } = recording(() => ok({ result: "OK" }));
  await upstash("https://eu1.upstash.io/", "tok", send).command(["SET", "run:abc", "{\"id\":\"abc\"}"]);

  const [call] = seen;
  // A trailing slash on the endpoint does not become a double slash.
  expect(call?.url).toBe("https://eu1.upstash.io");
  expect(call?.init?.method).toBe("POST");
  // The token as a bearer header, never in the URL, where it would reach logs.
  expect((call?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
  expect(JSON.parse(String(call?.init?.body))).toEqual(["SET", "run:abc", "{\"id\":\"abc\"}"]);
});

/** Keys used to be built into the path by hand. In the body, a strange id is only a strange key. */
test("a key never becomes part of the URL", async () => {
  const { send, seen } = recording(() => ok({ result: null }));
  await upstash("https://eu1.upstash.io", "tok", send).command(["GET", "run:../../flushall"]);
  expect(seen[0]?.url).toBe("https://eu1.upstash.io");
  expect(JSON.parse(String(seen[0]?.init?.body))).toEqual(["GET", "run:../../flushall"]);
});

test("a key that was never written is null, not an error", async () => {
  const { send } = recording(() => ok({ result: null }));
  expect(await upstash("https://eu1.upstash.io", "tok", send).command(["GET", "run:never"])).toBeNull();
});

test("a transaction goes to its own address, and answers each command in order", async () => {
  const { send, seen } = recording(() => ok([{ result: "OK" }, { result: 1 }, { result: 3 }]));
  const answers = await upstash("https://eu1.upstash.io", "tok", send)
    .transaction([["SET", "a", "1"], ["SADD", "s", "x"], ["SCARD", "s"]]);
  expect(seen[0]?.url).toBe("https://eu1.upstash.io/multi-exec");
  expect(answers).toEqual(["OK", 1, 3]);
});

/**
 * The bug the first version of this file was written for.
 *
 * Upstash reports a bad command as `{"error": …}` with a 200, so checking the status alone reads it
 * as success, and a run would be believed written when it was not.
 */
test("an error carried by a 200 is still a failure", async () => {
  const { send } = recording(() => ok({ error: "ERR value is not an integer or out of range" }));
  await expect(upstash("https://eu1.upstash.io", "tok", send).command(["INCR", "a"])).rejects.toThrow(/ERR value/);
});

/** Inside a transaction one command can fail while the others run, and it says so only in its own answer. */
test("one failed command fails the whole transaction", async () => {
  const { send } = recording(() => ok([{ result: "OK" }, { error: "WRONGTYPE Operation against a key" }]));
  await expect(upstash("https://eu1.upstash.io", "tok", send).transaction([["SET", "a", "1"], ["SADD", "a", "x"]]))
    .rejects.toThrow(/SADD failed: WRONGTYPE/);
});

/** A transaction refused before it ran arrives as a 400 carrying the reason, which is worth keeping. */
test("a transaction refused outright says why", async () => {
  const { send } = recording(() => ok({ error: "EXECABORT Transaction discarded" }, 400));
  await expect(upstash("https://eu1.upstash.io", "tok", send).transaction([["SADD"]])).rejects.toThrow(/EXECABORT/);
});

test("an http failure is a failure too", async () => {
  const { send } = recording(() => new Response("no", { status: 401, statusText: "Unauthorized" }));
  await expect(upstash("https://eu1.upstash.io", "tok", send).command(["GET", "a"])).rejects.toThrow(/401/);
});

/** A value can be a whole run record, and it has no business in a log line about a failure. */
test("a failure is named by its command, never by the values it carried", async () => {
  const { send } = recording(() => ok({ error: "ERR out of memory" }));
  const failure = await upstash("https://eu1.upstash.io", "tok", send)
    .command(["SET", "run:abc", "a record nobody should see in a log"])
    .catch((cause: unknown) => String(cause));
  expect(failure).toContain("SET");
  expect(failure).not.toContain("a record nobody should see");
});
