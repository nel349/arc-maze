import { createPublicClient, createWalletClient, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "./chain.ts";
import { efficiency, type PublishedRun } from "../maze/runs.ts";

/**
 * The prize: a record on the agent's own identity, written by somebody who is not the agent.
 *
 * Arc's ReputationRegistry refuses feedback from an agent's owner or operators —
 * `require(!isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed")` — which is the
 * entire reason a badge from us is worth having. An agent cannot award itself this, and neither can
 * whoever holds its identity. That is the difference between a reputation and a self-minted trophy.
 *
 * It is also portable. The record lands on the ERC-8004 identity the agent already has, readable by
 * any other service on Arc, rather than living in a leaderboard we host and could lose.
 *
 * **The score is efficiency, as a percentage, where 100 means it walked the shortest route there
 * is.** Chosen over cost or step count because both are better when *lower*, and a reputation value
 * that improves as it shrinks will be misread by the first person who does not read the tag. The
 * units are stated on chain in the tag rather than assumed, because this is permanent and a number
 * with no unit is a number somebody else will interpret wrongly.
 */

const REGISTRY: Address = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const IDENTITY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";


const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);
const identityAbi = parseAbi([
  "function getAgentWallet(uint256 agentId) view returns (address)",
]);

const publicClient = createPublicClient({ chain: arc, transport: http() });

/** Whole percent: the registry takes an integer and a decimal count, and 0 keeps it readable. */
const VALUE_DECIMALS = 0;
const TAG_GAME = "arc-maze";
/** The unit, on chain, so a later reader never has to guess what 100 meant. */
const TAG_UNITS = "efficiency-pct";

export interface Written {
  readonly agentId: bigint;
  readonly value: number;
  readonly hash: `0x${string}`;
}

/**
 * Whether a declared identity belongs to whoever paid for the run, as one of three answers.
 *
 * An agent declares its own id — there is no reverse lookup on the registry, so it has to — and a
 * declaration nobody checks is an invitation to write reputation onto somebody else's identity.
 * `getAgentWallet` is the check: the id's agent wallet has to be the address that paid. An id nobody
 * registered answers the zero address, so it differs rather than failing.
 *
 * Three answers, not a yes or a no, because the old no covered two different things: an identity that
 * is not the payer's, and an RPC having a bad minute. Arc's public endpoint turns busy callers away,
 * and one refused read cost a run its reward for good. A read that did not happen is `unreadable`,
 * and the caller asks again rather than deciding.
 */
export type IdentityCheck = "matches" | "differs" | "unreadable";

export async function checkIdentity(agentId: bigint, payer: string): Promise<IdentityCheck> {
  try {
    const wallet = await publicClient.readContract({
      address: IDENTITY, abi: identityAbi, functionName: "getAgentWallet", args: [agentId],
    });
    return wallet.toLowerCase() === payer.toLowerCase() ? "matches" : "differs";
  } catch (cause) {
    console.warn(`could not read agent ${agentId}'s wallet to check it against ${payer}:`,
      cause instanceof Error ? cause.message : cause);
    return "unreadable";
  }
}

export interface Scribe {
  write(agentId: bigint, run: PublishedRun, runUrl: string, digest: `0x${string}`): Promise<Written>;
}

/**
 * Writes feedback with the maze's own key.
 *
 * A separate key from anything else, holding only enough to pay for these calls. It is the only
 * private key this service has, and losing it costs the ability to write reputation — not anybody's
 * money, and not the record of runs already written.
 */
export function scribe(privateKey: `0x${string}`, endpoint: string): Scribe {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: arc, transport: http() });

  return {
    async write(agentId, run, runUrl, digest) {
      const value = efficiency(run);
      const hash = await wallet.writeContract({
        address: REGISTRY,
        abi: reputationAbi,
        functionName: "giveFeedback",
        args: [
          agentId,
          BigInt(value),
          VALUE_DECIMALS,
          TAG_GAME,
          TAG_UNITS,
          endpoint,
          runUrl,
          digest,
        ],
      });
      await publicClient.waitForTransactionReceipt({ hash });
      return { agentId, value, hash };
    },
  };
}

// Re-exported so the chain module still reads as the place reputation is defined, while the
// arithmetic itself lives with the run it describes — see `maze/runs.ts` for why.
export { efficiency };
export { REGISTRY, IDENTITY, TAG_GAME, TAG_UNITS };
