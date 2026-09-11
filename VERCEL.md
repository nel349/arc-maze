# Deploying

The Bun preset: Vercel looks for a `server.ts` in the root, detects the single `Bun.serve()` call
it makes at startup, and routes every request through it. Our router, our typed params and every
handler are the ones that run locally — there is no separate serverless shape to maintain.

`1.x` pins Bun to 1.3.14, which is the version this is developed against. `1.4.x` is a rewrite with
breaking changes and is not worth meeting for the first time on a deadline.

## What ships with the function

The function is `api/server.ts`, and it is one line: it imports the root server for its side
effect. Everything it needs — that root file and the whole of `src/` — lives outside `api/`, and
without being told, the deployment does not carry them. Bun then fails to resolve an import at
startup and every request is a 500, with `ResolveMessage {}` in the logs and nothing else.

`includeFiles` is what says to bring them. It could not be used before: that key addresses
Serverless Functions under `api/`, and until this entrypoint existed there was no function for the
pattern to match, so Vercel refused the deployment outright.

## The browser scripts, and why the first thing to check is the animation

`page.ts` reads the two browser scripts from disk at startup and transpiles them. Nothing imports
them, so anything that ships only what it can trace from imports would leave them behind — and the
failure is silent: the page renders and the replay simply never moves.

They are covered by the same `includeFiles` above, since `src/**` includes them. That is a claim
rather than a proof until it is seen. **Check the front page's replay, not the front page.**

## Environment

Set in Vercel's project settings, never in this file — it is committed.

| | |
|---|---|
| `SELLER_ADDRESS` | where payments go. Refused at startup if absent, rather than defaulted |
| `PUBLIC_URL` | the deployment's own address. Quoted inside every reputation record, for ever |
| `MAZE_REPUTATION_KEY` | signs reputation. Owns nothing and is allowed nothing |
| `MAZE_ADMITTER_KEY` | mints badges, and by the contract may do nothing else |
| `BADGE_CONTRACT` | the badge. Absent means no badges, and the maze still runs. Reading how full the cohort is takes no key, so the front page keeps its count regardless |
| `UPSTASH_REDIS_REST_URL` | where every run is kept, so every copy of the server sees the same ones |
| `UPSTASH_REDIS_REST_TOKEN` | |

The owner key is deliberately absent from that list. It appoints the minter and moves the metadata,
and it did both from a laptop; nothing this deployment does needs it. If `MAZE_PRIVATE_KEY` — the
name it used to run under — is ever set here again, the server refuses to start rather than run with
it, because a key that can mint the whole cohort should not sit in an environment nobody revisits.

`PUBLIC_URL` matters more than it looks. Without it the server calls itself `localhost`, and that
name is written into on-chain reputation records permanently — a link nobody but us can open. Set
it to the deployment's real hostname before the first solve, not after.

## What is known to be wrong here, before anyone finds it

**Vercel runs several copies of the server and stops each once it has answered.** Two things follow,
and both are handled rather than hoped about. Every run lives in Upstash, not in a copy's memory, so
whichever copy takes a payment finds the run, and every page draws the same boards. And a solve's
reward is paid before the solving step answers, because anything started after the answer is
stopped with the function: on 10 September that is how a solve earned nothing.

**The live stream's notifications are per copy.** A watcher is told about payments taken by the copy
it is connected to. What it is shown is always read from the store, so it is never wrong, but it can
be late until that copy hears something or the page is reloaded.

**The live stream is cut at 300 seconds** on the Hobby plan. `EventSource` reconnects on its own,
so it recovers; it is worth knowing before it looks like a fault.

**The cohort plate is missing on a cold start.** How full the cohort is, is read in the background
so a slow RPC cannot stall a render — right on a long-lived server, wrong here, where every cold
start is a fresh process that answers before the read returns. The first visitor sees no plate and
the second sees the count. The first visitor is exactly who the scarcity is aimed at.
