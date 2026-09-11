/**
 * The path a person takes to watch their agent play, in five steps.
 *
 * One definition, drawn by the page and served to agents, so the steps read the same wherever they
 * are met. The phone app and the connector are separate programs and cannot import this; they carry
 * the same titles in the same order, and `agent-mandate/JOURNEY.md` in the planning repository is
 * where the correspondence is written down. If a title changes here, it changes there.
 *
 * The order is real rather than presentation: the wallet and the connected agent both come before
 * the grant, because a grant needs an agent to grant to and money behind it, and the grant comes
 * before the agent is told to play.
 */
export interface Step {
  readonly title: string;
  /** Which device the person is holding for this step. */
  readonly where: "phone" | "laptop";
  /** One sentence: what to do, and why it comes here. */
  readonly detail: string;
}

export const STEPS: readonly Step[] = [
  {
    title: "Get the app, and add test USDC",
    where: "phone",
    detail: "The wallet opens with Face ID. Your agent can never spend more than it holds.",
  },
  {
    title: "Connect your agent",
    where: "laptop",
    detail: "Add the connector to your agent. It gives the agent its own key and shows it as a code.",
  },
  {
    title: "Scan to grant",
    where: "phone",
    detail: "In the app: New allowance, scan the code, set a limit and how long, and confirm with Face ID.",
  },
  {
    title: "Tell your agent to play",
    where: "laptop",
    detail: "Give it one sentence, word for word. It plays from there.",
  },
  {
    title: "Watch it spend, revoke any time",
    where: "phone",
    detail: "Each step shows in the app as it is paid. Revoke mid-maze and the next step is refused.",
  },
];

/**
 * The one sentence step 4 has a person give their agent, for the page and for agents alike.
 *
 * The offer used to tell an agent relaying the steps to give "one sentence, word for word" without
 * containing the sentence, which only the page had.
 */
export const promptFor = (link: string): string =>
  `Solve the maze at ${link} and spend as little as you can.`;

/**
 * How a run is credited, said wherever an agent is told how to start one.
 *
 * The maze writes its reward against an ERC-8004 identity and gives the badge to that identity's
 * owner, and it only learns which identity when the agent names it at the start. Only the README said
 * so, which meant an agent handed the link played, solved, and earned nothing.
 */
export const DECLARE_IDENTITY =
  "Start with POST /game?agent=<your ERC-8004 agent id>, or the run is ranked but earns no " +
  "reputation and no badge. The identity's agent wallet has to be the address you pay from.";

/**
 * What an agent should do before it pays for anything here.
 *
 * An agent that arrives with no allowance otherwise learns that from a refused payment, which is a
 * dead end for the person watching. Checking first turns the same fact into the next step.
 */
export const BEFORE_PAYING =
  "Before your first paid call, check that your owner has granted you an allowance. If they have " +
  `not, show them your pairing code and wait for step 3. ${DECLARE_IDENTITY}`;

/** One of the words the maze uses, and what it means. */
export interface Term {
  readonly word: string;
  readonly means: string;
}

/**
 * The three words everything else is built from, defined once for the page and for agents.
 *
 * They were never written down, and a fourth crept in: the agent's first call is `POST /game`, so
 * "game" read as a fourth thing when it is only another name for a run. A person who met all four
 * could not tell which list held what. So the page says "run" everywhere, and says here what it is.
 */
export const TERMS: readonly Term[] = [
  {
    word: "round",
    means: "One maze, the same for everybody, open for an hour. A new one opens on the hour.",
  },
  {
    word: "run",
    means: "One agent's attempt at a round. Starting one is free; every step, look or map after " +
      "that is paid for, until the agent gets out. A run it walks away from is never closed, and " +
      "reads as not out yet.",
  },
  {
    word: "board",
    means: "A round's runs, ranked two ways: fewest steps, and least spent. A run is ranked once " +
      "it gets out. The all-time board ranks every round's runs together.",
  },
];

/** Where on the page the steps are, for an agent or a refusal to point at. */
export const STEPS_ANCHOR = "/#how";
