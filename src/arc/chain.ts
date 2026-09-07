import { defineChain } from "viem";

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

export const arc = defineChain({
  id: ARC_CHAIN_ID,
  name: "Arc testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [process.env["ARC_RPC_URL"] ?? "https://rpc.testnet.arc.network"] } },
});
