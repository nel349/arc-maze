import { defineChain, type Address } from "viem";

/**
 * Arc, described once.
 *
 * The chain id was written in two places — a number in the reputation writer and a CAIP-2 string
 * in the paywall — which is two chances to point half of this at the wrong network and find out
 * from a refusal that says `unsupported_network`.
 */
export const ARC_CHAIN_ID = 5042002;

/** The CAIP-2 form x402 uses on the wire. */
export const ARC_NETWORK = `eip155:${ARC_CHAIN_ID}` as const;

/** Arc's USDC as an ERC-20: the same balance as the native token, at six decimals not eighteen. */
export const USDC = "0x3600000000000000000000000000000000000000";

/** Circle's Gateway Wallet — the contract a payment is signed against, rather than the token. */
export const GATEWAY = "0x0077777d7eba4688bdef3e311b846f25870a19b9";

/** Arc testnet's block explorer, for the links a person follows to check a claim on chain. */
export const EXPLORER = "https://testnet.arcscan.app";

export const arc = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.network"] } },
  blockExplorers: { default: { name: "ArcScan", url: EXPLORER } },
});

/**
 * Checks that a configured value really is the hex it claims to be, before anything signs with it.
 *
 * These arrive as strings from the environment and were previously asserted into shape with `as`,
 * which tells the compiler to stop asking and changes nothing at run time. A key with a stray
 * newline, a truncated paste, or an address in the key's slot then travelled all the way into viem
 * and failed there, where the message names an internal function rather than the variable somebody
 * actually mistyped.
 *
 * **The value is never included in the error.** Half of what this validates is a private key, and
 * an error message is the easiest way for one to reach a log aggregator. The name and the expected
 * shape are enough to fix it.
 */
const hex = (name: string, value: string, digits: number, what: string): `0x${string}` => {
  if (!new RegExp(`^0x[0-9a-fA-F]{${digits}}$`).test(value)) {
    throw new Error(`${name} is not ${what}: expected 0x followed by ${digits} hex digits`);
  }
  return value as `0x${string}`;
};

/** A 32-byte signing key. */
export const asPrivateKey = (name: string, value: string): `0x${string}` =>
  hex(name, value, 64, "a private key");

/** A 20-byte account or contract address. */
export const asAddress = (name: string, value: string): Address =>
  hex(name, value, 40, "an address");
