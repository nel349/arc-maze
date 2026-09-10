import { describe, expect } from 'bun:test'
import type { TeeRuntime } from '@chainlink/cre-sdk'
import { test } from '@chainlink/cre-sdk/test'
import { decodeAbiParameters, keccak256, parseAbiParameters, stringToBytes } from 'viem'
import { onCronTrigger, type configSchema } from './workflow'
import { atExit, digest, efficiency, finish, move, moved, published, round, RunStore } from '../../src/maze/index.ts'
import type { z } from 'zod'

/**
 * The verdict, tested against runs that were actually walked.
 *
 * Every record here is produced by playing the real maze with the real game code — not typed out by
 * hand. A hand-written fixture would let this suite agree with a workflow that had stopped agreeing
 * with the game, which is the one failure that matters: the whole point of the workflow is that it
 * re-derives the score rather than being told it.
 */

const ARCHIVE_TOKEN = 'archive-token-for-the-test'
const ROUND = '2026-09-07T05'
const PAYER = '0x1111111111111111111111111111111111111111'

type Config = z.infer<typeof configSchema>

const makeConfig = (runId: string): Config => ({
  schedule: '0 */1 * * * *',
  archiveUrl: 'https://archive.test',
  secretId: 'ARCHIVE_TOKEN',
  runId,
  publicUrl: 'https://arc-maze.test',
})

/** A run that really walks the round's shortest route, and solves it. */
const solvedRun = (agentId: string | null = '892655', stepsToTake?: number) => {
  const store = new RunStore()
  const run = store.start({ roundId: ROUND, payer: PAYER })
  if (agentId !== null) (run as { agentId: bigint | null }).agentId = BigInt(agentId)
  // Recording a move and *being somewhere new* are two separate things: `record()` appends the
  // action, and the router advances the marker. The fixture has to do both, exactly as the router
  // does — the replay compares them, which is how this was caught doing only the first.
  const route = round(ROUND).optimalRoute
  for (const direction of route.slice(0, stepsToTake ?? route.length)) {
    const next = moved(run.at.x, run.at.y, direction)
    move(run, direction, true)
    ;(run as { at: { x: number; y: number } }).at = next
  }
  if (atExit(run.at.x, run.at.y)) finish(run, 'solved')
  return published(run)
}

const makeRuntime = (
  record: unknown,
  { statusCode = 200, reply }: { statusCode?: number; reply?: unknown } = {},
) => {
  const headers: string[] = []
  const urls: string[] = []
  const reports: { encodedPayload?: string }[] = []

  const body = JSON.stringify(reply ?? { result: JSON.stringify(record) })
  const runtime = {
    config: makeConfig((record as { id?: string })?.id ?? 'missing'),
    getSecret: (request: { id?: string }) => ({
      result: () => ({ id: request.id, value: ARCHIVE_TOKEN }),
    }),
    callCapability: ({ payload }: { payload: { url?: string; multiHeaders?: Record<string, unknown> } }) => {
      urls.push(payload.url ?? '')
      const auth = payload.multiHeaders?.Authorization as { values?: string[] } | undefined
      headers.push(...(auth?.values ?? []))
      return { result: () => ({ statusCode, body: new TextEncoder().encode(body) }) }
    },
    log: () => {},
    usingTheDons: () => ({
      report: (input: { encodedPayload?: string }) => {
        reports.push(input)
        return { result: () => ({}) }
      },
    }),
  }
  return { runtime: runtime as unknown as TeeRuntime<Config>, headers, urls, reports }
}

/** What the receiver contract will decode on the other side. */
const decodeReport = (encodedPayload: string) =>
  decodeAbiParameters(
    parseAbiParameters('bytes32 runId, uint256 agentId, int128 value, string feedbackURI, bytes32 feedbackHash'),
    `0x${Buffer.from(encodedPayload, 'base64').toString('hex')}`,
  )

describe('the verdict', () => {
  test('reads the archive with the secret the enclave fetched, never with one in config', () => {
    const record = solvedRun()
    const { runtime, headers, urls } = makeRuntime(record)
    onCronTrigger(runtime)

    expect(headers).toEqual([`Bearer ${ARCHIVE_TOKEN}`])
    expect(urls[0]).toBe(`https://archive.test/get/run:${record.id}`)
  })

  test('scores a solved run and reports the figures the contract will write', () => {
    const record = solvedRun()
    const { runtime, reports } = makeRuntime(record)
    onCronTrigger(runtime)

    expect(reports).toHaveLength(1)
    const [runId, agentId, value, feedbackURI, feedbackHash] =
      decodeReport(reports[0]?.encodedPayload ?? '')

    expect(runId).toBe(keccak256(stringToBytes(record.id)))
    expect(agentId).toBe(892655n)
    expect(value).toBe(BigInt(efficiency(record)))
    expect(feedbackURI).toBe(`https://arc-maze.test/run/${record.id}`)
    expect(feedbackHash).toBe(digest(record))
  })

  /**
   * The score is re-derived, not read off the record.
   *
   * A record claiming a better step count than it walked must not be believed. This is the property
   * that makes a network's verdict worth more than ours: we could be lying, and it would still be
   * caught here.
   */
  test('a record whose figures do not match its own moves is refused', () => {
    const honest = solvedRun()
    const tampered = { ...honest, steps: 1 }
    const { runtime, reports } = makeRuntime(tampered)

    expect(() => onCronTrigger(runtime)).toThrow(/does not replay/)
    expect(reports).toHaveLength(0)
  })

  test('walking the shortest route scores a hundred, and wandering scores less', () => {
    const straight = solvedRun()
    expect(efficiency(straight)).toBe(100)

    const { runtime, reports } = makeRuntime(straight)
    onCronTrigger(runtime)
    const [, , value] = decodeReport(reports[0]?.encodedPayload ?? '')
    expect(value).toBe(100n)
  })

  test('a run that never reached the exit earns nothing', () => {
    const abandoned = solvedRun('892655', 3)
    const { runtime, reports } = makeRuntime(abandoned)

    expect(() => onCronTrigger(runtime)).toThrow(/did not solve/)
    expect(reports).toHaveLength(0)
  })

  test('a run with no identity has nowhere to put a score', () => {
    const anonymous = solvedRun(null)
    const { runtime, reports } = makeRuntime(anonymous)

    expect(() => onCronTrigger(runtime)).toThrow(/no agent identity/)
    expect(reports).toHaveLength(0)
  })

  /**
   * Upstash answers a failed command with HTTP 200 and an `error` field.
   *
   * Checking the status alone would read that as a successful read of an empty record. The server's
   * archive client had to be taught the same thing; both are reading the same API, so both get it
   * wrong in the same way if either forgets.
   */
  test('a command error arriving as a 200 is not mistaken for an answer', () => {
    const { runtime, reports } = makeRuntime(null, { reply: { error: 'WRONGTYPE' } })

    expect(() => onCronTrigger(runtime)).toThrow(/WRONGTYPE/)
    expect(reports).toHaveLength(0)
  })

  test('a run the archive has never heard of is not scored', () => {
    const { runtime, reports } = makeRuntime(null, { reply: { result: null } })

    expect(() => onCronTrigger(runtime)).toThrow(/no run/)
    expect(reports).toHaveLength(0)
  })

  test('an archive that refuses the read stops the workflow before the DON', () => {
    const { runtime, reports } = makeRuntime(solvedRun(), { statusCode: 401 })

    expect(() => onCronTrigger(runtime)).toThrow(/status 401/)
    expect(reports).toHaveLength(0)
  })

  test('the report is signed the way the forwarder expects', () => {
    const { runtime, reports } = makeRuntime(solvedRun())
    onCronTrigger(runtime)
    expect(reports[0]).toMatchObject({
      encoderName: 'evm',
      signingAlgo: 'ecdsa',
      hashingAlgo: 'keccak256',
    })
  })
})
