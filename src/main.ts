import { routes } from "./server.ts";
import { roundIdAt } from "./maze/index.ts";
import { registrar, scribe } from "./arc/index.ts";

/**
 * The only thing in this project that listens on a port.
 *
 * Kept separate so the routes stay a value that a test can call directly — a test that has to bind
 * a socket is a test that fails on a busy machine and leaves a listener behind when it crashes.
 */

const seller = process.env["SELLER_ADDRESS"];
if (seller === undefined) {
  // Refused rather than defaulted: a seller quietly paying a placeholder address collects nothing
  // and finds out from an empty balance a week later.
  throw new Error("SELLER_ADDRESS must be set to the address payments should go to");
}

/**
 * The key that writes reputation, which is not the key anything else uses.
 *
 * Optional on purpose: without it the maze runs and simply pays out no records, which is far better
 * than refusing to start. It holds only enough to pay for those writes, so losing it costs the
 * ability to write reputation — not anybody's money, and not the runs already published.
 */
const writingKey = process.env["MAZE_PRIVATE_KEY"];
const publicUrl = process.env["PUBLIC_URL"] ?? `http://localhost:${process.env["PORT"] ?? 8790}`;
if (writingKey === undefined) {
  console.warn("MAZE_PRIVATE_KEY is not set — runs will be played and scored, but no reputation written");
}

/** Optional in the same way the writing key is: no badge contract, no badges, and the maze runs. */
const badgeContract = process.env["BADGE_CONTRACT"];

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 8790),
  routes: routes({
    seller,
    publicUrl,
    ...(writingKey === undefined
      ? {}
      : { scribe: scribe(writingKey as `0x${string}`, publicUrl) }),
    ...(writingKey === undefined || badgeContract === undefined
      ? {}
      : { registrar: registrar(writingKey as `0x${string}`, badgeContract as `0x${string}`) }),
  }),
  fetch: () => new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  }),
});

console.log(`arc-maze on :${server.port} — round ${roundIdAt()}, paying ${seller}`);
