import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, parseEther, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "../src/arc/chain.ts";

/**
 * Deploys the badge with minting and governing held by two different keys, and carries the existing
 * cohort across.
 *
 * The first deployment welded `admit` to `onlyOwner`, so the server that mints on every solve also
 * held the power to repoint every badge's art and hand the contract away. There is no way to add a
 * role to a contract already on chain, so the split costs a redeployment — and a redeployment means
 * the badges already issued have to be reissued, in their original order, or somebody's number
 * changes underneath them.
 *
 * Prints what it would do and sends nothing, unless `--send` is passed.
 *
 *     bun scripts/deploy-badge.ts                      # the plan
 *     bun scripts/deploy-badge.ts --send               # the plan, executed
 *     bun scripts/deploy-badge.ts --rehearsal --send   # a throwaway cohort, for practice
 *
 * **Why a rehearsal mode exists.** One badge per address, for ever, is the promise the contract
 * makes — so the same person cannot be admitted twice, and a run-through of the demo mints nothing
 * the second time. Rehearsing against the real cohort would mean spending its hundred places on
 * practice, and "one hundred, then it closes" is the entire reason the badge is worth having.
 *
 * A fresh contract has an empty ledger and a counter at zero, so every rehearsal admits somebody as
 * #1 again. Reset is a redeployment, which costs a few seconds on a testnet. Nothing else differs:
 * same source, same owner, same admitter, same call — so what is rehearsed is the real thing, which
 * is the point of rehearsing at all.
 *
 * Run from a laptop with the owner key, which is the last thing that key is needed for. After this
 * it governs, and governing is not a thing a server does.
 */

/** Where the metadata will live. The first deployment pointed at a domain that was never registered. */
const BASE_URI = "https://arc-maze.vercel.app/badge/";

/**
 * The cohort as it stands, in the order it was issued.
 *
 * Read off the old contract rather than assumed, then written down here, because a migration that
 * discovers its own inputs at run time is a migration you cannot review before it runs.
 */
const CARRY_OVER: readonly Address[] = [
  "0x3535816e967Ad2B6271dfadf9138fb07eAB161Ce", // #1 — the agent's own key
  "0xc3BB7bc7E375f7ffA34E652F560Dc802F7A76cFa", // #2 — the smart account
];

/** Enough for a hundred mints and change, on a chain where a mint costs a fraction of a cent. */
const GAS_STAKE = parseEther("0.1");

const need = (name: string): string => {
  const value = process.env[name];
  if (value === undefined) throw new Error(`${name} is not set — see .env`);
  return value;
};

const ownerKey = need("BADGE_OWNER_KEY") as `0x${string}`;
const admitter = privateKeyToAccount(need("MAZE_ADMITTER_KEY") as `0x${string}`);
const reputation = privateKeyToAccount(need("MAZE_REPUTATION_KEY") as `0x${string}`);
const owner = privateKeyToAccount(ownerKey);

const artifact = JSON.parse(
  readFileSync(new URL("../contracts/out/CohortZero.sol/CohortZero.json", import.meta.url), "utf8"),
) as { abi: readonly unknown[]; bytecode: { object: `0x${string}` } };

const publicClient = createPublicClient({ chain: arc, transport: http() });
const wallet = createWalletClient({ account: owner, chain: arc, transport: http() });

const send = process.argv.includes("--send");
/** A throwaway cohort for practice. Carries nobody over, and is never the one anyone is admitted to. */
const rehearsal = process.argv.includes("--rehearsal");
const carryOver = rehearsal ? [] : CARRY_OVER;

console.log(`owner      ${owner.address}   ${formatEther(await publicClient.getBalance({ address: owner.address }))} USDC`);
console.log(`admitter   ${admitter.address}   ${formatEther(await publicClient.getBalance({ address: admitter.address }))} USDC`);
console.log(`reputation ${reputation.address}   ${formatEther(await publicClient.getBalance({ address: reputation.address }))} USDC`);
console.log(`baseURI    ${BASE_URI}`);
console.log(`carry over ${carryOver.length === 0 ? "(nobody — a fresh cohort)" : carryOver.join(", ")}`);
if (rehearsal) {
  console.log("\nREHEARSAL. A throwaway cohort, so the real one keeps its hundred places.");
}

if (owner.address.toLowerCase() === admitter.address.toLowerCase()) {
  throw new Error("the owner and the admitter are the same address, which is the bug this fixes");
}

if (!send) {
  console.log("\nDry run. Nothing sent. Pass --send to do it.");
  process.exit(0);
}

/** Gas for the two keys that will do the routine work, so the owner key never has to again. */
for (const [label, account] of [["admitter", admitter], ["reputation", reputation]] as const) {
  const held = await publicClient.getBalance({ address: account.address });
  if (held >= GAS_STAKE) {
    console.log(`${label} already funded (${formatEther(held)} USDC)`);
    continue;
  }
  const hash = await wallet.sendTransaction({ to: account.address, value: GAS_STAKE - held });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`funded ${label} ${account.address} — ${hash}`);
}

const deployHash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode.object,
  args: [BASE_URI, owner.address, admitter.address],
});
const deployed = await publicClient.waitForTransactionReceipt({ hash: deployHash });
const contract = deployed.contractAddress;
if (contract === null || contract === undefined) throw new Error("deployed but no address in the receipt");
console.log(`\nCohortZero at ${contract} — ${deployHash}`);

/** Reissued by the admitter, not the owner — the first proof that the split actually holds. */
const minting = createWalletClient({ account: admitter, chain: arc, transport: http() });
for (const holder of carryOver) {
  const hash = await minting.writeContract({
    address: contract, abi: artifact.abi, functionName: "admit", args: [holder],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`admitted ${holder} — ${hash}`);
}

console.log(
  rehearsal
    ? `\nSet BADGE_CONTRACT=${contract} wherever you are rehearsing — and nowhere permanent.\n` +
      `Run this again to start over: a new contract has admitted nobody, so the same holder is #1 again.`
    : `\nSet BADGE_CONTRACT=${contract} in .env and in Vercel.`,
);
