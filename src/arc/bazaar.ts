/**
 * Discovery metadata, declared on every `402`.
 *
 * A resource becomes discoverable by describing itself here and settling through a facilitator that
 * catalogues. **Nothing catalogues Arc.** Circle settles Arc and runs no discovery endpoint; every
 * catalogue that exists does not settle Arc. So this is, today, a sign hung in a room with no
 * shelves.
 *
 * It is here anyway. It costs a few bytes on a response nobody is charged for, it is what the spec
 * asks a seller to do, and the day somebody builds that shelf this is already on it. Writing it
 * later would mean going back through every route to remember what each one takes and returns.
 */

export interface Bazaar {
  readonly info: {
    readonly input: {
      readonly type: "http";
      readonly method: "GET" | "POST";
      readonly queryParams?: Readonly<Record<string, string>>;
    };
    readonly output: { readonly type: "json"; readonly example: unknown };
  };
  readonly schema: Readonly<Record<string, unknown>>;
}

const jsonObject = (properties: Readonly<Record<string, unknown>>, required: readonly string[]) => ({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties,
  required,
});

/** Shared by every priced route: what an agent always gets back about its own run. */
const RUN_STATE = {
  run: { type: "string" },
  round: { type: "string" },
  at: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
  steps: { type: "number" },
  spentUsd: { type: "number" },
  outcome: { type: "string", enum: ["running", "solved", "gave-up"] },
} as const;

export const MOVE: Bazaar = {
  info: {
    input: { type: "http", method: "POST", queryParams: { dir: "e" } },
    output: {
      type: "json",
      example: { run: "…", at: { x: 1, y: 0 }, steps: 1, spentUsd: 0.001, moved: true, wall: false },
    },
  },
  schema: jsonObject(
    { ...RUN_STATE, moved: { type: "boolean" }, wall: { type: "boolean" } },
    ["run", "at", "steps", "spentUsd", "moved"],
  ),
};

export const LOOK: Bazaar = {
  info: {
    input: { type: "http", method: "GET" },
    output: { type: "json", example: { run: "…", exits: ["e", "s"], spentUsd: 0.002 } },
  },
  schema: jsonObject(
    { ...RUN_STATE, exits: { type: "array", items: { type: "string", enum: ["n", "s", "e", "w"] } } },
    ["run", "exits"],
  ),
};

export const MAP: Bazaar = {
  info: {
    input: { type: "http", method: "GET" },
    output: {
      type: "json",
      example: {
        run: "…",
        exit: { x: 5, y: 5 },
        openings: [[["e"], ["s", "w"]]],
        map: "┌───┬───┐\n│ ◆     │\n└───┴───┘",
      },
    },
  },
  schema: jsonObject(
    {
      ...RUN_STATE,
      exit: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } } },
      // The grid is what a machine plans a route from; the drawing is for whoever is watching it.
      openings: { type: "array", items: { type: "array", items: { type: "array", items: { type: "string" } } } },
      map: { type: "string" },
    },
    ["run", "exit", "openings", "map"],
  ),
};
