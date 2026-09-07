import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";

/**
 * The facilitator's own shapes, derived from the method we call rather than imported.
 *
 * Circle's batching client declares a narrower `PaymentPayload` than `@x402/core` exports, and
 * importing core's would force a cast that hides the difference — exactly the kind of assertion
 * that turns a library upgrade into a runtime surprise. Deriving from the signature means these
 * follow whatever Circle changes them to, and the compiler tells us when that happens.
 */
type Facilitator = Pick<BatchFacilitatorClient, "verify" | "settle">;
type PaymentPayload = Parameters<Facilitator["verify"]>[0];
type PaymentRequirements = Parameters<Facilitator["verify"]>[1];

/**
 * Charging for a request, in the shape sellers and buyers already agree on.
 *
 * HTTP reserved `402 Payment Required` in 1997 and never used it. x402 finally does: the server
 * answers 402 with a machine-readable note saying what it costs and who to pay, the client signs a
 * payment and retries, and the server serves. What makes it work for an agent is what is *absent* —
 * no account, no API key, no card, nobody agreeing to terms.
 *
 * On Arc the signature is checked off chain by Circle's Gateway and settled later in a batch with
 * hundreds of others, which is why a step in this maze can cost a tenth of a cent and still be
 * worth collecting. A payment here is not a transaction; it is a signed promise that becomes one
 * about a quarter of an hour later. Anything reporting results has to keep those two apart.
 *
 * Nothing in this file is specific to a maze. It is the smallest honest x402 seller we could write,
 * and that is deliberate — the interesting half of this project is the buyer.
 */

const ARC_NETWORK = "eip155:5042002";
/** Arc's USDC as an ERC-20: the same balance as the native token, at six decimals not eighteen. */
const USDC = "0x3600000000000000000000000000000000000000";
/** Circle's Gateway Wallet — the contract a payment is signed against, rather than the token. */
const GATEWAY = "0x0077777d7eba4688bdef3e311b846f25870a19b9";

/**
 * Gateway will not batch an authorisation that might expire before the batch settles, so it
 * requires a week. A seller advertising less is asking for a payment the facilitator will refuse.
 */
const MIN_VALIDITY_SECONDS = 7 * 24 * 60 * 60;

/** Prices are decided in dollars; the wire wants micro-USDC. */
const toAtomic = (usd: number): string => String(Math.round(usd * 1_000_000));

export const requirementsFor = (priceUsd: number, payTo: string): PaymentRequirements => ({
  scheme: "exact",
  network: ARC_NETWORK,
  asset: USDC,
  amount: toAtomic(priceUsd),
  payTo,
  maxTimeoutSeconds: MIN_VALIDITY_SECONDS,
  extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY },
});

export interface Charged {
  readonly payer: string;
  readonly settlement: string | undefined;
}

export type ChargeOutcome =
  | { readonly kind: "unpaid"; readonly paymentRequired: unknown }
  | { readonly kind: "unreadable" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "paid"; readonly charged: Charged };

export interface Offer {
  readonly priceUsd: number;
  readonly payTo: string;
  readonly resource: string;
  readonly description: string;
  /** Discovery metadata, so a catalogue could index this. See `bazaarFor`. */
  readonly bazaar?: unknown;
}

const b64 = {
  encode: (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64"),
  decode: (value: string): unknown => JSON.parse(Buffer.from(value, "base64").toString("utf8")),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Does this header carry the shape the facilitator expects?
 *
 * A guard rather than an assertion, because the header is written by whoever is calling us. Casting
 * it to `PaymentPayload` would tell the compiler a stranger's JSON is well formed, which is the one
 * thing we do not know — and the failure would surface inside Circle's client, as a confusing error
 * about somebody else's code.
 *
 * Only the two fields the client actually reads are checked. The facilitator is still the authority
 * on whether the payment is *valid*; this decides whether it is worth asking.
 */
const isPaymentPayload = (value: unknown): value is PaymentPayload =>
  isRecord(value) && typeof value["x402Version"] === "number" && isRecord(value["payload"]);

/**
 * What a `402` tells a buyer.
 *
 * The `bazaar` block describes the endpoint so a catalogue could index it. Nothing indexes Arc
 * today — Circle settles Arc and does not catalogue it, and every catalogue that exists does not
 * settle Arc — so this is currently shouting into a room with no shelves. It is here anyway: it
 * costs nothing, it is correct, and the day somebody builds that shelf we are already on it.
 */
export function paymentRequired(offer: Offer): Record<string, unknown> {
  return {
    x402Version: 2,
    resource: { url: offer.resource, description: offer.description, mimeType: "application/json" },
    accepts: [requirementsFor(offer.priceUsd, offer.payTo)],
    ...(offer.bazaar === undefined ? {} : { extensions: { bazaar: offer.bazaar } }),
  };
}

/**
 * Take payment for one request, or explain why not.
 *
 * Verify then settle, in that order and both before anything is served. Verifying alone would let a
 * well-formed but unfundable payment through; settling without verifying spends a round trip to
 * learn the same thing. If either refuses, nothing is served and nothing is charged.
 *
 * Returns an outcome rather than writing a response, so the routes decide what a refusal looks like
 * and this stays testable without a socket.
 */
export class Paywall {
  readonly #facilitator: Facilitator;

  constructor(facilitator?: Facilitator) {
    this.#facilitator = facilitator ?? new BatchFacilitatorClient();
  }

  async charge(header: string | null | undefined, offer: Offer): Promise<ChargeOutcome> {
    if (!header) return { kind: "unpaid", paymentRequired: paymentRequired(offer) };

    let decoded: unknown;
    try {
      decoded = b64.decode(header);
    } catch {
      return { kind: "unreadable" };
    }
    if (!isPaymentPayload(decoded)) return { kind: "unreadable" };
    const payload = decoded;

    const requirements = requirementsFor(offer.priceUsd, offer.payTo);
    const verified = await this.#facilitator.verify(payload, requirements);
    if (!verified.isValid) {
      return { kind: "refused", reason: verified.invalidReason ?? "the facilitator did not say" };
    }

    const settled = await this.#facilitator.settle(payload, requirements);
    if (!settled.success) {
      return { kind: "refused", reason: settled.errorReason ?? "settlement did not say why" };
    }

    const payer = (settled.payer ?? verified.payer ?? "").toLowerCase();
    if (payer === "") return { kind: "refused", reason: "settled without naming a payer" };

    return {
      kind: "paid",
      charged: { payer, settlement: settled.transaction ?? undefined },
    };
  }
}

export { ARC_NETWORK, USDC, GATEWAY, b64 };
