/**
 * The pages a person moves between, written once.
 *
 * The router answers these and the pages link to them, and a link typed by hand in one place and a
 * route renamed in another is a page that 404s from its own navigation. The rounds and runs take an
 * id, so they are functions.
 */
export const PAGES = {
  home: "/",
  board: "/board",
  runs: "/runs",
} as const;

export const roundHref = (id: string): string => `/round/${encodeURIComponent(id)}`;

export const runHref = (id: string): string => `/run/${encodeURIComponent(id)}`;
