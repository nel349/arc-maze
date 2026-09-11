import { storeKeys, upstash } from "../src/archive.ts";
import { isRunId, verify, type PublishedRun, type RunSummary } from "../src/maze/index.ts";

/**
 * Lists the runs that were kept before every run was listed.
 *
 * Until the shared store, the only runs kept were solves that earned reputation, each under
 * `run:<id>`, and nothing listed them. This adds each one to the lists the pages now read: its
 * round's board and the list of every run. The records themselves are not touched, because a
 * reputation record on chain commits to their digest.
 *
 * The runs that were never kept cannot be brought back. They lived in the memory of copies of the
 * server that no longer exist.
 *
 * Prints what it would add, and adds it only with `--send`. Safe to repeat: listing a run again
 * writes the same summary over itself.
 *
 *     bun scripts/list-kept-runs.ts
 *     bun scripts/list-kept-runs.ts --send
 */

const need = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) {
    console.error(`${name} must be set`);
    process.exit(1);
  }
  return value;
};

const send = process.argv.includes("--send");
const db = upstash(need("UPSTASH_REDIS_REST_URL"), need("UPSTASH_REDIS_REST_TOKEN"));
const key = storeKeys();
const RUN_PREFIX = key.run("");

const found: PublishedRun[] = [];
let cursor = "0";
do {
  const answer = await db.command(["SCAN", cursor, "MATCH", `${RUN_PREFIX}*`, "COUNT", 500]);
  if (!Array.isArray(answer)) throw new Error("SCAN answered something other than a cursor and keys");
  const [next, keys] = answer as [string, string[]];
  for (const name of keys) {
    const id = name.slice(RUN_PREFIX.length);
    // Anything else under this prefix was put there by hand, a probe, and is not a run.
    if (!isRunId(id)) {
      console.log(`skipped      ${name}: not a run id`);
      continue;
    }
    const stored = await db.command(["GET", name]);
    const record = JSON.parse(String(stored)) as PublishedRun;
    const replay = verify(record);
    if (!replay.ok) {
      console.log(`skipped      ${id}: does not replay (${replay.problems.join("; ")})`);
      continue;
    }
    found.push(record);
  }
  cursor = next;
} while (cursor !== "0");

for (const record of found) {
  const { actions: _actions, ...summary } = record;
  const listed: RunSummary = summary;
  console.log(`${send ? "listed" : "would list"}  ${record.id}  round ${record.round}  ${record.outcome}, ` +
    `${record.steps} steps, $${record.spentUsd}`);
  if (send) {
    const json = JSON.stringify(listed);
    await db.transaction([
      ["HSET", key.round(record.round), record.id, json],
      ["HSET", key.every, record.id, json],
    ]);
  }
}
if (!send) console.log("\nNothing written. Pass --send to add these to the lists.");
