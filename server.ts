import { routes } from "./src/routes.ts";
import { roundIdAt } from "./src/maze/index.ts";
import { registrar, roster, scribe } from "./src/arc/index.ts";
import { upstashArchive } from "./src/archive.ts";

/**
 * The only thing in this project that listens on a port.
 *
 * Kept separate so the routes stay a value that a test can call directly — a test that has to bind
 * a socket is a test that fails on a busy machine and leaves a listener behind when it crashes.
 *
 * It sits at the root, and is named `server.ts`, because that is what Vercel's Bun preset looks
 * for: it detects the `Bun.serve()` call made once at startup and routes requests through it. The
 * routes module had to give up that name — it never listened to anything, so `routes.ts` was
 * always the better one. `port` is ignored there and used here.
 */

const seller = process.env["SELLER_ADDRESS"];
if (seller === undefined) {
  // Refused rather than defaulted: a seller quietly paying a placeholder address collects nothing
  // and finds out from an empty balance a week later.
  throw new Error("SELLER_ADDRESS must be set to the address payments should go to");
}

/**
 * Two keys, because this service does two jobs that need different permissions.
 *
 * Neither of them owns anything. The reputation key writes feedback, which needs no privilege at
 * all — anyone may write feedback about an agent that is not their own. The admitter key is the one
 * address the badge contract allows to mint, and the contract allows it nothing else: it cannot
 * move the metadata, appoint a different minter, or hand the contract away.
 *
 * That separation is the point. This process runs on a host we do not own, so the key that governs
 * the cohort is not here — it signed the deployment from a laptop and does not need to exist on a
 * server again. Losing everything in this environment costs the ability to write reputation and up
 * to a hundred badges. It does not cost ownership of anything.
 *
 * Both are optional, and independently so: with no reputation key the maze plays and scores but
 * writes nothing, and with no admitter key it writes reputation and mints no badges. Refusing to
 * start over a missing key would take the whole game down to protect a trophy.
 */
const writingKey = process.env["MAZE_REPUTATION_KEY"];
const admitterKey = process.env["MAZE_ADMITTER_KEY"];
const publicUrl = process.env["PUBLIC_URL"] ?? `http://localhost:${process.env["PORT"] ?? 8790}`;
if (writingKey === undefined) {
  console.warn("MAZE_REPUTATION_KEY is not set — runs will be played and scored, but no reputation written");
}

/**
 * The old name for the owner key, refused rather than ignored.
 *
 * It used to be one key doing both jobs, and that key owned the badge contract — so a deployment
 * still carrying it is a deployment handing this host the power to mint every remaining badge and
 * repoint the art. Starting anyway and quietly not using it would leave that key sitting in an
 * environment nobody revisits.
 */
if (process.env["MAZE_PRIVATE_KEY"] !== undefined) {
  throw new Error(
    "MAZE_PRIVATE_KEY is set. That was the badge contract's owner key, and this service no longer " +
    "uses it: reputation is signed by MAZE_REPUTATION_KEY and badges are minted by " +
    "MAZE_ADMITTER_KEY, neither of which owns anything. Remove it from this environment — if it is " +
    "still the owner key, it should exist nowhere but a laptop.",
  );
}

/** Optional in the same way the keys are: no badge contract, no badges, and the maze runs. */
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
    ...(willWrite && admitterKey !== undefined && badgeContract !== undefined
      ? { registrar: registrar(admitterKey as `0x${string}`, badgeContract as `0x${string}`) }
      : {}),
    // Reading how full the cohort is takes no key, so the plate survives a deployment that is not
    // allowed to mint — including one where the admitter has deliberately been set to nobody.
    ...(badgeContract === undefined ? {} : { roster: roster(badgeContract as `0x${string}`) }),
    ...(archive === undefined ? {} : { archive }),
  }),
  fetch: () => new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  }),
});

console.log(`arc-maze on :${server.port} — round ${roundIdAt()}, paying ${seller}`);
