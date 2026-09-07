import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";

/**
 * Charging for a request, in the shape sellers and buyers already agree on.
 *
 * HTTP reserved `402 Payment Required` in 1997 and never used it. x402 finally does: the server
 * answers 402 with a machine-readable note saying what it costs and who to pay, the client signs a
 * payment and retries, and the server serves. What makes it work for an agent is what is *absent* —
 * no account, no API key, no card, no human agreeing to terms.
 *
 * On Arc the signature is checked off-chain by Circle's Gateway and settled later in a batch with
 * hundreds of others, which is why a step in this maze can cost a tenth of a cent and still be
 * worth collecting. A payment here is not a transaction; it is a signed promise that becomes one
 * about sixteen minutes later.
 *
 * Nothing in this file is specific to a maze. It is the smallest honest x402 seller we could
 * write, and that is deliberate — the interesting part of the project is the buyer.
 */

const ARC = "eip155:5042002";
/** Arc's USDC as an ERC-20: the same balance as the native token, at six decimals instead of eighteen. */
const USDC = "0x3600000000000000000000000000000000000000";
/** Circle's Gateway Wallet, which is the contract a payment is signed against rather than the token. */
const GATEWAY = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

/**
 * Gateway will not batch an authorisation that might expire before the batch settles, so it
 * requires a week. A seller advertising less is asking for a payment the facilitator will refuse.
 */
const MIN_VALIDITY_SECONDS = 7 * 24 * 60 * 60;

const facilitator = new BatchFacilitatorClient({ url: process.env.GATEWAY_API ?? undefined });

const b64 = {
  encode: (v) => Buffer.from(JSON.stringify(v)).toString("base64"),
  decode: (v) => JSON.parse(Buffer.from(v, "base64").toString("utf8")),
};

/** Prices are written in dollars because that is how they are decided; the wire wants micro-USDC. */
const toAtomic = (usd) => String(Math.round(usd * 1_000_000));

export function requirementsFor(priceUsd, payTo) {
  return {
    scheme: "exact",
    network: ARC,
    asset: USDC,
    amount: toAtomic(priceUsd),
    payTo,
    maxTimeoutSeconds: MIN_VALIDITY_SECONDS,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY.toLowerCase() },
  };
}

/**
 * What a `402` tells a buyer.
 *
 * The `bazaar` block describes the endpoint so a catalog could index it. Nothing indexes Arc today
 * — Circle settles Arc and does not catalog it, and every catalog that exists does not settle Arc
 * — so this is currently shouting into a room with no shelves. It is here anyway, because the
 * cost is nothing and the day somebody builds that shelf, this is already on it.
 */
function paymentRequired({ price, payTo, resource, description, bazaar }) {
  return {
    x402Version: 2,
    resource: { url: resource, description, mimeType: "application/json" },
    accepts: [requirementsFor(price, payTo)],
    ...(bazaar ? { extensions: { bazaar } } : {}),
  };
}

/**
 * Wrap a handler so it costs money.
 *
 * Verify then settle, in that order and both before the handler runs. Verifying alone would let a
 * well-formed but unfundable payment through; settling without verifying would spend a round trip
 * to learn the same thing. If either refuses, nothing is served and nothing is charged.
 */
export function charge({ price, payTo, description, bazaar }, handler) {
  return async (request, response, context) => {
    const header = request.headers["payment-signature"];
    const requirements = requirementsFor(price, payTo);

    if (!header) {
      const body = paymentRequired({ price, payTo, resource: context.url, description, bazaar });
      response.writeHead(402, {
        "content-type": "application/json",
        "payment-required": b64.encode(body),
      });
      // The body repeats the header in plain JSON. The header is what the protocol reads; the body
      // is for the person holding curl, who would otherwise get a blank 402 and no idea why.
      response.end(JSON.stringify({ error: "payment required", ...body }, null, 2));
      return;
    }

    let payload;
    try {
      payload = b64.decode(header);
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "the payment header was not readable base64 JSON" }));
      return;
    }

    const verified = await facilitator.verify(payload, requirements);
    if (!verified.isValid) {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "payment refused", reason: verified.invalidReason }));
      return;
    }

    const settled = await facilitator.settle(payload, requirements);
    if (!settled.success) {
      response.writeHead(402, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "payment did not settle", reason: settled.errorReason }));
      return;
    }

    const payer = (settled.payer ?? verified.payer ?? "").toLowerCase();
    response.setHeader("payment-response", b64.encode({
      success: true, transaction: settled.transaction, network: ARC, payer,
    }));
    await handler(request, response, { ...context, payer, paid: price });
  };
}

export { ARC, USDC, GATEWAY };
