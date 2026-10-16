import { loadGameSystem } from './bcdice.js';

/** The plain dice bot used for a system it does not know. As in Axe, an unknown id rolls with this. */
export const PLAIN_DICE_BOT = 'DiceBot';

/** The result of a roll: the text of the chat message, the mark, and the breakdown of the dice. */
export interface Rolled {
  /** The text of the message, in the same form as when Axe rolls by itself. */
  text: string;
  /** A secret roll (shown only to the one who rolled and the GM). */
  secret: boolean;
  /**
   * The numbers rolled and the success or failure, as JSON (the dicebot of ChatMessage). Empty when
   * there are none.
   */
  dicebot: string;
}

/** Of what BCDice returns, only the parts that are used. */
interface BCDiceResult {
  text: string;
  secret: boolean;
  success?: boolean;
  failure?: boolean;
  critical?: boolean;
  fumble?: boolean;
  rands?: [number, number][];
  detailedRands?: { kind?: string; sides?: number; value?: number }[];
}

const numberOf = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/**
 * Turns the numbers rolled and the success or failure into JSON of the same form as Axe's
 * encodeDiceRollDetail (dice-roll-detail.ts).
 * Empty when there is neither.
 */
export const encodeDetail = (system: string, result: BCDiceResult): string => {
  const faces = (
    result.detailedRands
      ? result.detailedRands.map((entry) => ({
          sides: numberOf(entry.sides),
          value: numberOf(entry.value),
          kind: typeof entry.kind === 'string' ? entry.kind : 'normal',
        }))
      : (result.rands ?? []).map(([value, sides]) => ({
          sides: numberOf(sides),
          value: numberOf(value),
          kind: 'normal',
        }))
  ).filter((face) => face.sides > 0);
  // A critical or a fumble comes with a success or a failure, so the stronger ones are looked at
  // first.
  const outcome = result.critical
    ? 'critical'
    : result.fumble
      ? 'fumble'
      : result.success
        ? 'success'
        : result.failure
          ? 'failure'
          : '';
  if (faces.length === 0 && outcome === '') return '';
  return JSON.stringify({ system, faces, outcome });
};

/**
 * Rolls one line of chat as a dice command. Null when it is not a command.
 *
 * In the same steps as Axe's DiceBot (handleSendMessage, diceRollAsync and sendResultMessage),
 * it turns a leading count (`3 2d6`) into `x3`, rolls only what fits the form of the system's
 * commands, and puts the text of the result into the same form. text has had its full-width
 * characters turned into half-width ones (Axe turns them before it sends).
 */
export const rollLine = async (gameType: string, text: string): Promise<Rolled | null> => {
  const match = /^((\d+)?\s+)?(.*)?/i.exec(text) as RegExpExecArray;
  const repeat = match[2] !== undefined ? Number(match[2]) : 1;
  let command = match[3] ?? text;
  const system =
    (await loadGameSystem(gameType)) ??
    ((await loadGameSystem(PLAIN_DICE_BOT)) as NonNullable<Awaited<ReturnType<typeof loadGameSystem>>>);
  if (system.COMMAND_PATTERN && !system.COMMAND_PATTERN.test(command)) return null;
  if (!command || repeat < 1) return null;
  if (repeat > 1) command = `x${repeat} ${command}`;

  let result: BCDiceResult | null;
  try {
    result = system.eval(command) as BCDiceResult | null;
  } catch {
    return null;
  }
  if (!result) return null;

  let formatted = `${system.ID} : ${result.text}`
    // Puts repeated rolls one to a line, and drops the line break right after the heading.
    .replace(/\n*(#\d+)\n/gi, '\n$1 ')
    .replace(/: \n/, ': ')
    .replace(/[＞]/g, '→')
    .trim();
  // A result that goes through three or more steps gets a line for each step.
  if (formatted.split(' → ').length > 3) formatted = formatted.replace(/ → /g, '\n→ ');
  return { text: formatted, secret: result.secret, dicebot: encodeDetail(system.ID, result) };
};
