import { cre, hexToBase64, ok, text, type TeeRuntime } from '@chainlink/cre-sdk'
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToBytes } from 'viem'
import { z } from 'zod'
import { digest, efficiency, verify, type PublishedRun } from '../../src/maze/index.ts'

/**
 * The verdict, decided by a network and written by a contract nobody holds a key for.
 *
 * Until now the maze both computed a score and signed it into Arc's reputation registry. The
 * registry refuses only *self*-feedback, so nothing structurally stopped a seller flattering its
 * own customers — and the key that signed sat on a host we do not own.
 *
 * Here the score is re-derived from the published record rather than taken from us. The maze is
 * rebuilt from the round id, every recorded move is replayed, and the ending square, the step count
 * and the amount charged are all recomputed. A record that does not survive that is not scored.
 *
 * Two different properties are doing two different jobs, and it is worth keeping them apart:
 *
 *   - **Consensus** is what makes the verdict not ours to fake. The Workflow DON agrees on the
 *     result before any report is signed, so a lie would have to be told by the network.
 *   - **The enclave** is what makes the archive credential not ours to leak. The token that reads
 *     the authoritative record is released by the Vault DON directly into an attested TEE and is
 *     never visible to node operators.
 *
 * What the enclave does *not* hide is this logic: the workflow binary is provided to the enclave by
 * the Workflow DON and is revealed. That is fine — the scoring is open source and is supposed to be
 * checkable. What must stay hidden is the credential and the record payload, and those do.
 */

export const configSchema = z.object({
  schedule: z.string(),
  /** The Upstash REST base the record is read from. */
  archiveUrl: z.string(),
  /** Which Vault DON secret holds the token for that archive. */
  secretId: z.string(),
  /** The run to score. */
  runId: z.string(),
  /** Quoted inside the reputation record, permanently, so a reader can fetch the evidence. */
  publicUrl: z.string(),
})
type Config = z.infer<typeof configSchema>

/** The shape Upstash answers a GET with. A command error arrives as 200 with `error` set. */
interface ArchiveReply {
  readonly result?: string | null
  readonly error?: string
}

export const onCronTrigger = (runtime: TeeRuntime<Config>): string => {
  const config = runtime.config

  // ── Inside the enclave ──────────────────────────────────────────────────────
  // The Vault DON releases this only into an attested TEE, decrypted at the moment it is asked for.
  const token = runtime.getSecret({ id: config.secretId }).result().value

  const key = `run:${encodeURIComponent(config.runId)}`
  const response = new cre.capabilities.HTTPClient()
    .sendRequest(runtime, {
      url: `${config.archiveUrl.replace(/\/$/, '')}/get/${key}`,
      method: 'GET',
      multiHeaders: { Authorization: { values: [`Bearer ${token}`] } },
    })
    .result()

  if (!ok(response)) {
    throw new Error(`the archive refused the read: status ${response.statusCode}`)
  }

  // Upstash reports command failures as a 200 with `error` set, so the status alone is not an
  // answer — the same trap the server's archive client had to be taught about.
  const reply = JSON.parse(text(response)) as ArchiveReply
  if (reply.error !== undefined) throw new Error(`the archive refused the read: ${reply.error}`)
  if (reply.result === null || reply.result === undefined) {
    throw new Error(`no run ${config.runId} in the archive`)
  }

  const run = JSON.parse(reply.result) as PublishedRun

  // ── The part that makes this worth doing ────────────────────────────────────
  // Nothing here trusts the record's own claims. The maze is rebuilt from the round id and every
  // move is replayed; the ending square, the steps and the spend are all recomputed.
  const replay = verify(run)
  if (!replay.ok) {
    throw new Error(`the record does not replay: ${replay.problems.join('; ')}`)
  }
  if (run.outcome !== 'solved') {
    throw new Error(`run ${run.id} did not solve the maze, so there is nothing to credit`)
  }
  if (run.agentId === null || run.agentId === undefined) {
    throw new Error(`run ${run.id} has no agent identity to write reputation onto`)
  }

  const value = efficiency(run)
  const feedbackHash = digest(run)
  const feedbackURI = `${config.publicUrl.replace(/\/$/, '')}/run/${run.id}`

  // ── Back to the DON ─────────────────────────────────────────────────────────
  // Everything crossed here stops being confidential, so only the verdict crosses: never the token,
  // never the record.
  const donRuntime = runtime.usingTheDons()

  const payload = encodeAbiParameters(
    parseAbiParameters('bytes32 runId, uint256 agentId, int128 value, string feedbackURI, bytes32 feedbackHash'),
    [keccak256(stringToBytes(run.id)), BigInt(run.agentId), BigInt(value), feedbackURI, feedbackHash],
  )

  donRuntime
    .report({
      encodedPayload: hexToBase64(payload),
      encoderName: 'evm',
      signingAlgo: 'ecdsa',
      hashingAlgo: 'keccak256',
    })
    .result()

  return `run ${run.id}: agent ${run.agentId} scored ${value} (${run.steps} steps, optimal ${run.optimalSteps}) — ${feedbackHash}`
}

export function initWorkflow(config: Config) {
  const cronTrigger = new cre.capabilities.CronCapability()
  return [
    cre.handlerInTee(cronTrigger.trigger({ schedule: config.schedule }), onCronTrigger, [
      { tee: 'nitro', regions: ['us-west-2'] },
    ]),
  ]
}
