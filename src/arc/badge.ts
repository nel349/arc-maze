import {
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, decodeEventLog, http,
  parseAbi, type Address,
} from "viem";
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
 *
 * **Reading and minting are separated here for the same reason they are separated on chain.** How
 * full the cohort is, is public: the front page wants it on every render and it needs no key to
 * ask. Admitting somebody needs the one key allowed to mint. Keeping them in one object meant a
 * server that only wanted to draw the number had to hold the key that could empty the cohort.
 */

const badgeAbi = parseAbi([
  "function admit(address holder) returns (uint256)",
  "function remaining() view returns (uint256)",
  "function COHORT_SIZE() view returns (uint256)",
  "function hasBadge(address holder) view returns (bool)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "event Admitted(address indexed holder, uint256 indexed tokenId, uint256 remaining)",
]);

const identityAbi = parseAbi(["function ownerOf(uint256 tokenId) view returns (address)"]);

const publicClient = createPublicClient({ chain: arc, transport: http() });

export interface Admitted {
  readonly holder: Address;
  readonly tokenId: bigint;
  readonly hash: `0x${string}`;
}

/**
 * Why a solver was not admitted, when that is an ordinary answer rather than a failure.
 *
 * Two of them, kept apart: a person told the cohort is full when they already hold a badge, or the
 * other way round, has been told something false about the one thing they came for.
 */
export const NO_BADGE = { full: "cohort-full", held: "already-held" } as const;
export type NoBadge = (typeof NO_BADGE)[keyof typeof NO_BADGE];

export interface Registrar {
  /** The badge minted, or why none was: every place is taken, or the identity's owner holds one. */
  admit(agentId: bigint): Promise<Admitted | NoBadge>;
}

export interface Roster {
  /** The badge contract, for the links a person follows to check it. */
  readonly contract: Address;
  /**
   * Who holds a badge, or null when no badge has that number.
   *
   * A revert is the contract saying there is no such badge, and is an answer. Anything else is the
   * chain not answering, and throws, so a page can say that instead of "no such badge".
   */
  holderOf(tokenId: bigint): Promise<Address | null>;
  /**
   * How many places are gone, for the front page. Null when the chain cannot be reached.
   *
   * Scarcity is the hook — "two of a hundred taken" is the reason to hurry — but it is not worth a
   * page that hangs when an RPC is slow, so callers are expected to serve a cached answer and
   * refresh behind the request rather than await this on the way to a render.
   */
  taken(): Promise<Cohort | null>;
}

/**
 * The public half: how full the cohort is, asked with no key.
 *
 * Separate from {@link registrar} so that drawing the number and being allowed to change it are
 * different capabilities. A deployment with no minting key still shows the count.
 */
export function roster(contract: Address): Roster {
  return {
    contract,

    async holderOf(tokenId) {
      try {
        return await publicClient.readContract({
          address: contract, abi: badgeAbi, functionName: "ownerOf", args: [tokenId],
        });
      } catch (cause) {
        const reverted = cause instanceof BaseError &&
          cause.walk((inner) => inner instanceof ContractFunctionRevertedError) !== null;
        if (reverted) return null;
        throw cause;
      }
    },

    async taken() {
      try {
        const [left, size] = await Promise.all([
          publicClient.readContract({ address: contract, abi: badgeAbi, functionName: "remaining" }),
          publicClient.readContract({ address: contract, abi: badgeAbi, functionName: "COHORT_SIZE" }),
        ]);
        return { minted: Number(size - left), of: Number(size) };
      } catch {
        // A number we cannot vouch for is worse than no number: the page omits the plate instead.
        return null;
      }
    },
  };
}

export interface Cohort {
  readonly minted: number;
  readonly of: number;
}

/**
 * Admits the owner of an agent's identity to the cohort.
 *
 * Holds the admitter key, which the contract allows to mint and to do nothing else — it cannot move
 * the metadata, cannot appoint a different minter, and cannot hand the contract away. That is the
 * whole reason this is a separate key from the one that governs, and why the governing key does not
 * have to exist on the host this runs on.
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
      if (left === 0n) return NO_BADGE.full;
      if (already) return NO_BADGE.held;

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
