# Deploying

The Bun preset: Vercel looks for a `server.ts` in the root, detects the single `Bun.serve()` call
it makes at startup, and routes every request through it. Our router, our typed params and every
handler are the ones that run locally — there is no separate serverless shape to maintain.

`1.x` pins Bun to 1.3.14, which is the version this is developed against. `1.4.x` is a rewrite with
breaking changes and is not worth meeting for the first time on a deadline.

## The browser scripts, and why the first thing to check is the animation

`page.ts` reads the two browser scripts from disk at startup and transpiles them. Nothing imports
them, so anything that ships only what it can trace from imports would leave them behind — and the
failure is silent: the page renders and the replay simply never moves.

`functions.includeFiles` was the obvious guard and it is the wrong tool: that key addresses
Serverless Functions under `api/`, which the framework preset does not use, and Vercel rejects the
deployment outright — *"the pattern server.ts defined in functions doesn't match any Serverless
Functions inside the api directory"*. The preset takes the repository as it stands, so the files go
up with everything else.

Which is a claim rather than a proof. **Check the front page's replay, not the front page.**

## Environment

Set in Vercel's project settings, never in this file — it is committed.

| | |
|---|---|
| `SELLER_ADDRESS` | where payments go. Refused at startup if absent, rather than defaulted |
| `PUBLIC_URL` | the deployment's own address. Quoted inside every reputation record, for ever |
| `MAZE_PRIVATE_KEY` | signs reputation and mints badges. The CohortZero owner |
| `BADGE_CONTRACT` | the badge. Absent means no badges, and the maze still runs |
| `UPSTASH_REDIS_REST_URL` | where records outlive the process |
| `UPSTASH_REDIS_REST_TOKEN` | |

`PUBLIC_URL` matters more than it looks. Without it the server calls itself `localhost`, and that
name is written into on-chain reputation records permanently — a link nobody but us can open. Set
it to the deployment's real hostname before the first solve, not after.

## What is known to be wrong here, before anyone finds it

**A run is only visible to the instance that created it.** Vercel runs several and recycles them,
so a run started on one can be told "no such run" by the next — after the agent has paid. Records
already survive, because those go to Upstash; a run in flight does not. That is #38, and until it
is done this is a demo that works because one person is using it.

**The live stream is cut at 300 seconds** on the Hobby plan. `EventSource` reconnects on its own,
so it recovers; it is worth knowing before it looks like a fault.
