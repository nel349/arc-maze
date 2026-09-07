/**
 * The game, which knows nothing about money.
 *
 * Everything here is a maze, a round, a run or a ranking. Nothing in this directory imports a
 * chain, a payment or a facilitator — that boundary is the reason the folders exist, and it is what
 * lets the rules be tested without a network.
 */
export * from "./grid.ts";
export * from "./round.ts";
export * from "./runs.ts";
export * from "./boards.ts";
