import { routes } from "./server.ts";
import { roundIdAt } from "./round.ts";

/**
 * The only thing in this project that listens on a port.
 *
 * Kept separate so the routes stay a value that a test can call directly — a test that has to bind
 * a socket is a test that fails on a busy machine and leaves a listener behind when it crashes.
 */

const seller = process.env["SELLER_ADDRESS"];
if (seller === undefined) {
  // Refused rather than defaulted: a seller quietly paying a placeholder address collects nothing
  // and finds out from an empty balance a week later.
  throw new Error("SELLER_ADDRESS must be set to the address payments should go to");
}

const server = Bun.serve({
  port: Number(process.env["PORT"] ?? 8790),
  routes: routes({ seller }),
  fetch: () => new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  }),
});

console.log(`arc-maze on :${server.port} — round ${roundIdAt()}, paying ${seller}`);
