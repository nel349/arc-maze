/**
 * A probe, not the server.
 *
 * Framework detection is not engaging — the build produced nothing and the CLI reports Node — so
 * this uses the other documented model, which needs only `bunVersion` and no preset at all. Its
 * one job is to answer the question that decides whether the real server can go here: **what path
 * does the function actually see** once a rewrite has sent every request to it?
 *
 * The docs say route overrides must be written with the `/api/server` prefix, which may or may not
 * mean the request arrives carrying it. Our router matches `/round/:id` and friends, so the answer
 * changes whether this is a five-line change or a rewrite. Delete this file either way.
 */
Bun.serve({
  fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      probe: "bun on vercel",
      bunVersion: typeof Bun === "undefined" ? null : Bun.version,
      pathname: url.pathname,
      search: url.search,
      // The two headers Vercel uses to carry the original request when it rewrites.
      forwardedPath: request.headers.get("x-vercel-original-path"),
      matchedPath: request.headers.get("x-matched-path"),
      // Proof the Bun-only APIs the maze depends on are actually present here.
      hasTranspiler: typeof Bun !== "undefined" && typeof Bun.Transpiler === "function",
    });
  },
});
