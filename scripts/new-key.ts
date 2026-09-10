import { appendFileSync, readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Makes a key, writes it to `.env`, and never shows it to anyone.
 *
 * The address is printed because you need it — to fund the key, and to name it in a constructor.
 * The key itself goes straight to a gitignored file and is never echoed, never passed as an
 * argument, and never pasted anywhere. A private key that appears in a terminal is a private key
 * in a scrollback buffer, a screen recording, and a shell history.
 *
 *     bun scripts/new-key.ts MAZE_ADMITTER_KEY
 *
 * Refuses to overwrite a name that already exists, because the second run of a command like this is
 * almost always a mistake, and the mistake silently replaces a funded key with an empty one.
 */

const name = process.argv[2];
if (name === undefined || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
  console.error("usage: bun scripts/new-key.ts ENV_VAR_NAME");
  process.exit(1);
}

const envPath = new URL("../.env", import.meta.url);
let existing = "";
try {
  existing = readFileSync(envPath, "utf8");
} catch {
  // No .env yet. Creating one is fine; the append below does it.
}

if (new RegExp(`^${name}=`, "m").test(existing)) {
  console.error(`${name} is already set in .env. Remove it by hand first if you really mean to replace it.`);
  process.exit(1);
}

const key = generatePrivateKey();
appendFileSync(envPath, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${name}=${key}\n`);

console.log(`${name} written to .env`);
console.log(`address: ${privateKeyToAccount(key).address}`);
console.log("fund that address with testnet gas before it can send anything.");
