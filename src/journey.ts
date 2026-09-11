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
 * What an agent should do before it pays for anything here.
 *
 * An agent that arrives with no allowance otherwise learns that from a refused payment, which is a
 * dead end for the person watching. Checking first turns the same fact into the next step.
 */
export const BEFORE_PAYING =
  "Before your first paid call, check that your owner has granted you an allowance. If they have " +
  "not, show them your pairing code and wait for step 3.";

/** Where on the page the steps are, for an agent or a refusal to point at. */
export const STEPS_ANCHOR = "/#how";
