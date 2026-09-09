import { expect, test } from "bun:test";
import { upstashArchive } from "../src/archive.ts";
import type { PublishedRun } from "../src/maze/index.ts";

/**
 * The wire, checked without a wire.
 *
 * These tests are about the request this sends and the reply it believes, which is the half that
 * cannot be verified by a fake `Archive` — every server test uses one of those, so all of them
 * would pass with this file written wrongly.
 *
 * No socket is bound, per the rule stated in `main.ts`: a test that has to listen on a port fails
 * on a busy machine and leaves a listener behind when it crashes. `fetch` is handed in instead.
 *
 * What they cannot prove is that Upstash agrees. The shape here is taken from its REST
 * documentation — `POST /set/<key>` with the value as the body, `GET /get/<key>`, a bearer token,
 * and `{"result": …}` back — and only running it against a real instance settles that.
 */

const RECORD = {
  id: "1f0d0b7e-0000-4000-8000-000000000000",
  round: "2026-09-01T00",
  payer: "0x1111111111111111111111111111111111111111",
  startedAt: "2026-09-01T00:10:00.000Z",
  finishedAt: "2026-09-01T00:12:00.000Z",
  outcome: "solved",
  steps: 30,
  spentUsd: 0.03,
  optimalSteps: 30,
  settlements: 30,
  actions: [],
} as unknown as PublishedRun;

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("keeping a record posts it to the key it will later be asked for", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const archive = upstashArchive("https://eu1.upstash.io/", "tok", async (url, init) => {
    seen.push({ url, ...(init === undefined ? {} : { init }) });
    return ok({ result: "OK" });
  });

  await archive.keep(RECORD);

  const [call] = seen;
  expect(call?.url).toBe(`https://eu1.upstash.io/set/run:${RECORD.id}`);
  expect(call?.init?.method).toBe("POST");
  // The token travels as a bearer header, not in the query string, where it would reach logs.
  expect((call?.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer tok");
  expect(JSON.parse(String(call?.init?.body))).toEqual(RECORD);
});

test("a trailing slash on the endpoint does not become a double slash in the path", async () => {
  const seen: string[] = [];
  const archive = upstashArchive("https://eu1.upstash.io/", "tok", async (url) => {
    seen.push(url);
    return ok({ result: null });
  });
  await archive.find("abc");
  expect(seen[0]).toBe("https://eu1.upstash.io/get/run:abc");
});

test("a record comes back as the record, not as the string it was stored as", async () => {
  const archive = upstashArchive("https://eu1.upstash.io", "tok", async () =>
    ok({ result: JSON.stringify(RECORD) }));
  expect(await archive.find(RECORD.id)).toEqual(RECORD);
});

test("a key that was never written is absent, not an error", async () => {
  const archive = upstashArchive("https://eu1.upstash.io", "tok", async () => ok({ result: null }));
  expect(await archive.find("never-stored")).toBeNull();
});

/**
 * The bug this file was written for.
 *
 * Upstash reports a bad command as `{"error": …}` **with a 200**, so checking the status alone
 * reads it as success — and for `keep` that means believing a record is safe when it is not, which
 * is the single thing this must never do quietly. The reputation write that follows would then
 * commit a URL on chain for a record nobody has.
 */
test("an error carried by a 200 is still a failure", async () => {
  const archive = upstashArchive("https://eu1.upstash.io", "tok", async () =>
    ok({ error: "ERR value is not an integer or out of range" }));

  await expect(archive.keep(RECORD)).rejects.toThrow(/ERR value/);
  await expect(archive.find(RECORD.id)).rejects.toThrow(/ERR value/);
});

test("an http failure is a failure too", async () => {
  const archive = upstashArchive("https://eu1.upstash.io", "tok", async () =>
    new Response("no", { status: 401, statusText: "Unauthorized" }));

  await expect(archive.keep(RECORD)).rejects.toThrow(/401/);
  await expect(archive.find(RECORD.id)).rejects.toThrow(/401/);
});

/** Ids come from `randomUUID`, but the key is built by hand and a stray one must not escape it. */
test("an id that would change the path is encoded", async () => {
  const seen: string[] = [];
  const archive = upstashArchive("https://eu1.upstash.io", "tok", async (url) => {
    seen.push(url);
    return ok({ result: null });
  });
  await archive.find("../../flushall");
  expect(seen[0]).toBe("https://eu1.upstash.io/get/run:..%2F..%2Fflushall");
});
