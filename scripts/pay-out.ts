import { privateKeyToAccount } from "viem/accounts";
import { runsInUpstash, upstash } from "../src/archive.ts";
import { asAddress, asPrivateKey, belongsTo, registrar, scribe } from "../src/arc/index.ts";
import { uncitable } from "../src/citable.ts";
import { digest, efficiency, isRunId, revive, verify, type PublishedRun } from "../src/maze/index.ts";
import { runHref } from "../src/paths.ts";
import { payOut } from "../src/reward.ts";

/**
 * Pays out a solve the server did not, from the run's public record.
 *
 * The server pays a solve out before the solving step answers. Before it did, the payout ran after
 * the answer, on a host that stops once it has answered, and on 10 September a solve earned nothing
 * for that reason. This pays such a run after the fact: from the same record, with the same checks,
 * through the same function the server uses, so a payout by hand cannot differ from one by the
 * server. The reward is reserved in the shared store first, so it cannot be paid twice, by this or by
 * the server.
 *
 * The record is fetched from the public address rather than read from the store, because that address
 * is what the reputation record will quote. If it does not answer with this record, nothing is written.
 *
 * Prints what it would do and sends nothing, unless `--send` is passed.
 *
 *     PUBLIC_URL=https://arc-maze.vercel.app bun scripts/pay-out.ts <run id>
 *     PUBLIC_URL=https://arc-maze.vercel.app bun scripts/pay-out.ts <run id> --send
 */

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const runId = process.argv[2] ?? "";
const send = process.argv.includes("--send");
if (!isRunId(runId)) fail("usage: PUBLIC_URL=https://… bun scripts/pay-out.ts <run id> [--send]");

const need = (name: string): string => process.env[name] ?? fail(`${name} must be set`);
const publicUrl = need("PUBLIC_URL").replace(/\/$/, "");
if (uncitable(publicUrl) !== null) fail(`${publicUrl} will not be there next week, and a reputation record quotes it for ever`);

// ── The record, as the world will read it ─────────────────────────────────────
const address = `${publicUrl}${runHref(runId)}`;
const response = await fetch(address, { headers: { accept: "application/json" } });
if (!response.ok) fail(`${address} answered ${response.status}; a record citing it would cite nothing`);
const served = (await response.json()) as PublishedRun & { readonly digest?: string };
const { digest: servedDigest, ...record } = served;
if (servedDigest !== digest(record)) fail(`${address} serves a digest that does not match its own record`);

// ── The checks the server makes ───────────────────────────────────────────────
const replay = verify(record);
if (!replay.ok) fail(`the record does not replay: ${replay.problems.join("; ")}`);
if (record.outcome !== "solved") fail(`run ${runId} did not solve the maze, so it has earned nothing`);
if (record.agentId === null || record.payer === null) fail(`run ${runId} declared no identity, so there is nobody to reward`);
const agentId = BigInt(record.agentId ?? "0");
if (!(await belongsTo(agentId, record.payer ?? ""))) fail(`agent ${agentId} does not belong to ${record.payer}, who paid`);

const reputationKey = asPrivateKey("MAZE_REPUTATION_KEY", need("MAZE_REPUTATION_KEY"));
const admitterKey = asPrivateKey("MAZE_ADMITTER_KEY", need("MAZE_ADMITTER_KEY"));
const badge = asAddress("BADGE_CONTRACT", need("BADGE_CONTRACT"));

console.log([
  `run          ${runId}, round ${record.round}`,
  `agent        ${agentId}, paid by ${record.payer}`,
  `score        ${efficiency(record)} (${record.steps} steps; the shortest is ${record.optimalSteps})`,
  `cites        ${address}`,
  `commits to   ${servedDigest}`,
  `written by   ${privateKeyToAccount(reputationKey).address}`,
  `badge        ${badge}, admitted by ${privateKeyToAccount(admitterKey).address}`,
].join("\n"));

if (!send) {
  console.log("\nNothing sent. Pass --send to write the reputation and admit the badge.");
  process.exit(0);
}

const reward = await payOut(revive(record), {
  runs: runsInUpstash(upstash(need("UPSTASH_REDIS_REST_URL"), need("UPSTASH_REDIS_REST_TOKEN"))),
  publicUrl,
  scribe: scribe(reputationKey, publicUrl),
  registrar: registrar(admitterKey, badge),
});
console.log(`\n${JSON.stringify(reward, null, 2)}`);
