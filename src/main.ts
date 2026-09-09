import { routes } from "./server.ts";
import { roundIdAt } from "./maze/index.ts";
import { registrar, scribe } from "./arc/index.ts";
import { upstashArchive } from "./archive.ts";

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

/**
 * Hosts that will not be there next week.
 *
 * A reputation record is permanent and quotes a URL. Written from behind a quick tunnel, it would
 * point at a name that dies when the process does — a permanent claim citing evidence nobody can
 * ever fetch, which is worse than no claim at all. So playing works from a tunnel and *writing*
 * does not, unless someone says out loud that they mean it.
 */
const EPHEMERAL_HOST = /\.(trycloudflare\.com|ngrok(-free)?\.app|ngrok\.io|loca\.lt)$/i;
const ephemeral = EPHEMERAL_HOST.test(new URL(publicUrl).hostname);
const insists = process.env["ALLOW_EPHEMERAL_URL"] === "true";
const willWrite = writingKey !== undefined && (!ephemeral || insists);

if (ephemeral && writingKey !== undefined && !insists) {
  console.warn(
    `PUBLIC_URL is a temporary tunnel (${new URL(publicUrl).hostname}). The maze will run and rank,\n` +
    "but no reputation or badges will be written: those quote this URL on chain, forever, and it\n" +
    "will not resolve tomorrow. Set ALLOW_EPHEMERAL_URL=true to write anyway.",
  );
}

/**
 * Where records go so they outlive this process.
 *
 * Both halves or neither. Absent, the maze runs exactly as before and a record lives as long as the
 * server — right for a laptop, wrong the moment a reputation record on chain quotes one of its URLs.
 */
const archiveUrl = process.env["UPSTASH_REDIS_REST_URL"];
const archiveToken = process.env["UPSTASH_REDIS_REST_TOKEN"];
const archive = archiveUrl !== undefined && archiveToken !== undefined
  ? upstashArchive(archiveUrl, archiveToken)
  : undefined;

/**
 * The one combination that fails quietly, so it is said out loud.
 *
 * Writing reputation commits a `/run/:id` URL on chain, permanently. With no archive behind it that
 * link dies with this process, and what is left on chain is a hash nobody can check pointing at a
 * page nobody can load — which reads as evidence and is not.
 */
if (willWrite && archive === undefined) {
  console.warn(
    "Reputation will be written, but no archive is configured: set UPSTASH_REDIS_REST_URL and\n" +
    "UPSTASH_REDIS_REST_TOKEN, or every /run/:id this commits on chain dies with this process.",
  );
}

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 8790),
  routes: routes({
    seller,
    publicUrl,
    ...(willWrite && writingKey !== undefined
      ? { scribe: scribe(writingKey as `0x${string}`, publicUrl) }
      : {}),
    ...(willWrite && writingKey !== undefined && badgeContract !== undefined
      ? { registrar: registrar(writingKey as `0x${string}`, badgeContract as `0x${string}`) }
      : {}),
    ...(archive === undefined ? {} : { archive }),
  }),
  fetch: () => new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  }),
});

console.log(`arc-maze on :${server.port} — round ${roundIdAt()}, paying ${seller}`);
