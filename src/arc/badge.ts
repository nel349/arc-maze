import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arc } from "./chain.ts";
import { IDENTITY } from "./reputation.ts";

/**
 * The half a person screenshots.
 *
 * The reputation record is what a machine reads — a score, a tag, a link to a replayable run. This
 * is a numbered badge, and the number is the whole point: it says an address was here while almost
 * nobody was doing this. A hundred places, then it closes, because "Cohort 0" that never closes
 * means less every week until it means nothing.
 *
 * **It goes to the identity's owner, not to the agent.** The agent's key did the walking, but the
 * badge is the human-legible half and a human holds the identity — the same split the mandate makes
 * everywhere else. An agent with no identity earns neither, which keeps one rule instead of two.
 */

const badgeAbi = parseAbi([
  "function admit(address holder) returns (uint256)",
  "function remaining() view returns (uint256)",
  "function hasBadge(address holder) view returns (bool)",
  "event Admitted(address indexed holder, uint256 indexed tokenId, uint256 remaining)",
]);

const identityAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

const publicClient = createPublicClient({ chain: arc, transport: http() });

export interface Admitted {
  readonly holder: Address;
  readonly tokenId: bigint;
  readonly hash: `0x${string}`;
}

export interface Registrar {
  /** Resolves to null when the cohort is closed, or this holder already has one. */
  admit(agentId: bigint): Promise<Admitted | null>;
}

/**
 * Admits the owner of an agent's identity to the cohort.
 *
 * Checks before writing, because both refusals are ordinary rather than exceptional — a full cohort
 * and a repeat holder are the two states this is *supposed* to reach, and spending a transaction to
 * be told so would be paying to learn something a read answers.
 */
export function registrar(privateKey: `0x${string}`, contract: Address): Registrar {
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: arc, transport: http() });

  return {
    async admit(agentId) {
      const holder = await publicClient.readContract({
        address: IDENTITY, abi: identityAbi, functionName: "ownerOf", args: [agentId],
      });

      const [left, already] = await Promise.all([
        publicClient.readContract({ address: contract, abi: badgeAbi, functionName: "remaining" }),
        publicClient.readContract({
          address: contract, abi: badgeAbi, functionName: "hasBadge", args: [holder],
        }),
      ]);
      if (left === 0n || already) return null;

      const hash = await wallet.writeContract({
        address: contract, abi: badgeAbi, functionName: "admit", args: [holder],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      // The number comes from the event the contract emitted, not from arithmetic on the supply.
      // Deriving it would duplicate the cohort size out here and be wrong the day it changes.
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== contract.toLowerCase()) continue;
        try {
          const event = decodeEventLog({ abi: badgeAbi, ...log });
          if (event.eventName === "Admitted") {
            return { holder, tokenId: event.args.tokenId, hash: receipt.transactionHash };
          }
        } catch {
          // Another log from the same contract — the ERC-721 Transfer — which is not what we want.
        }
      }
      throw new Error(`admitted ${holder} but the badge emitted no Admitted event`);
    },
  };
}
