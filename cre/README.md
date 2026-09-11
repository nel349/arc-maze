# Maze Verdict: a confidential CRE workflow

When an agent solves a round of the maze, it earns a score on its ERC-8004 identity in Arc's
reputation registry. This workflow decides that score **without trusting the maze**, and is meant to
be the only way one gets written.

It reads the run's published record, rebuilds the maze from the round id, replays every move, and
recomputes the steps, the spend and where the run ended. A record that does not replay is not
scored. From a record that does, it derives the score (efficiency: 100 means the shortest route
there is) and the record's digest, and signs a report for `MazeVerdict`
([`contracts/src/MazeVerdict.sol`](../contracts/src/MazeVerdict.sol)). That contract is the author
the registry records, and there is no private key behind it: a verdict can only be written by
convincing the network that a replay of the published run gives that number.

The replay is the same code the maze uses (`src/maze`), imported rather than copied, so the score a
person reads on the site and the score written on chain cannot drift apart.

## Why it runs in an enclave

The authoritative record lives in the maze's run store, and reading it takes the store's token. That
token also writes: anyone holding it could rewrite the very evidence the score is derived from. So
it must not be visible to the node operators who run the workflow.

| What makes it confidential | Where it happens |
|---|---|
| A confidential handler | `cre.handlerInTee(cron, onCronTrigger, [{ tee: 'nitro', regions: ['us-west-2'] }])` in `verdict/workflow.ts` |
| A secret used inside the enclave | `runtime.getSecret({ id: 'ARCHIVE_TOKEN' })`: the Vault DON releases the store token only into the attested enclave |
| A confidential response | the run record, fetched from inside the enclave with that token, and replayed there |
| Only the verdict leaves | `runtime.usingTheDons().report(...)` carries the run id's hash, the agent id, the score, the record's public address and its digest. Never the token, never the record |

What the enclave does not hide is the logic. The workflow binary is handed to the enclave and is
revealed, which is intended: the scoring is open source so that anyone can check it.

```
  Cron trigger (Workflow DON)
        │
        ▼
╔═══════════════════════════════════════════════════════════╗
║  ENCLAVE                                                  ║
║   getSecret('ARCHIVE_TOKEN')     released by the Vault DON ║
║   GET run:<id> from the store    with the token            ║
║   verify(record)                 rebuild the maze, replay  ║
║   efficiency(record), digest()   the score and the hash    ║
╚═══════════════════════════╤═══════════════════════════════╝
                            │ usingTheDons(): the verdict only
                            ▼
  Workflow DON: consensus, then a signed report
                            │ Chainlink's forwarder (once deployed)
                            ▼
  MazeVerdict on Arc ──► ReputationRegistry.giveFeedback
```

## Run it

Needs [Bun](https://bun.sh) and the [CRE CLI](https://docs.chain.link/cre) (checked with v1.33.0).

```bash
cd cre/verdict && bun install
```

`secrets.yaml` maps the secret `ARCHIVE_TOKEN` to the environment variable `SECRET_ARCHIVE_TOKEN`.
Set it to the store's token; it is never written to a file here.

Tests (every record in them is produced by walking the real maze with the real game code):

```bash
bun run test:workflow        # from the repository root
```

The settings are not committed, because they name the store. Copy the example and fill in the
store's address and the run to score:

```bash
cp verdict/config.example.json verdict/config.staging.json   # from cre/
```

Then simulate, from `cre/`:

```bash
SECRET_ARCHIVE_TOKEN=… cre workflow simulate verdict --target staging-settings --non-interactive --trigger-index 0
```

## Evidence

The simulation of that run, in the maze's round `2026-09-11T00` (12 steps, the shortest route there
is, $0.022):

```
╭────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ Trigger requested TEE Execution your trigger will run in one of the following Tees:                │
│     - AWS Nitro in us-west-2                                                                       │
│ The simulator is not a real TEE, and is meant to debug.                                            │
╰────────────────────────────────────────────────────────────────────────────────────────────────────╯
✓ Workflow Simulation Result:
"run 25b9f044-09da-49bb-8545-04f46efc03de: agent 892655 scored 100 (12 steps, optimal 12) — 0x3c6d1108c8ef7468fdaa20850892ce130540610625d23e02821807bdf18f1eae"
```

It agrees with what is on chain. The maze wrote this run's reputation with its own key in
transaction `0x226f769fc0df26df00590f9f675f1070c1b1a03d227a318cadbb73d656e63f39` on Arc testnet:
value 100, feedback hash `0x3c6d1108…1eae`. The workflow was not told either number. It read the
record and derived both.

## What it does not do yet

- **It runs in the simulator, not on the network.** Deploying a confidential workflow needs access
  to the Confidential Workflows beta, which we have requested and not received. The simulator is not
  a real enclave, and says so.
- **So the report has not reached Arc.** `MazeVerdict` is written and tested (`contracts/test/
  MazeVerdict.t.sol`) but not deployed, and until it is, the maze writes reputation with its own key.
  That key is exactly what this workflow exists to replace.
- **The run to score is set in the config.** On the network it would come from a trigger that fires
  on a solve. The cron trigger is kept because the simulator runs it on demand.

Started from Chainlink's Confidential Workflows starter template for TypeScript. The replay, the
scoring, the store read and the contract are this project's. MIT, like the rest of the repository.
