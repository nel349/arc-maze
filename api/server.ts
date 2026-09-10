/**
 * The entrypoint Vercel runs.
 *
 * Framework detection never engaged here — a build that produced nothing in under a second, and a
 * CLI reporting Node on a repository with `bun.lock`, a root `server.ts` and `bunVersion` set. The
 * other documented model needs no preset and no lockfile, only `bunVersion`, and it works: a probe
 * confirmed Bun 1.3.14, `Bun.Transpiler` present, and — the part that decided this shape — a
 * rewritten request arriving with its **original path intact**, so the router matches `/round/:id`
 * exactly as it does on a laptop.
 *
 * Importing the root server for its side effect rather than repeating it: that module calls
 * `Bun.serve()` once at startup, which is precisely what Vercel detects and routes through. One
 * server, one set of routes, one place the environment is read — and `bun run start` still runs
 * the same file locally, where the port it asks for is the port it gets.
 */
import "../server.ts";
