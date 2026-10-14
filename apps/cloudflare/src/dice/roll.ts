import { loadGameSystem } from './bcdice';

/** 知らないシステムのときに使う、ふつうのダイスボット。Axe と同じく、知らない ID はこれで振る */
export const PLAIN_DICE_BOT = 'DiceBot';

/** 振った結果。チャットの発言の文面と、印と、出目の内訳 */
export interface Rolled {
  /** 発言の文面。Axe が自分で振ったときと同じ形 */
  text: string;
  /** シークレットダイス（振った人と GM にだけ見せる） */
  secret: boolean;
  /** 出目と成否を JSON にしたもの（ChatMessage の dicebot）。無ければ空 */
  dicebot: string;
}

/** BCDice が返すもののうち、使うところだけ */
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
 * 出目と成否を、Axe の encodeDiceRollDetail と同じ形の JSON にする（dice-roll-detail.ts）。
 * どちらも無ければ空
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
  // クリティカルとファンブルは成功や失敗を伴うので、強いものから見る
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
 * チャットの1行をダイスのコマンドとして振る。コマンドでなければ null。
 *
 * Axe の DiceBot（handleSendMessage・diceRollAsync・sendResultMessage）と同じ手順で、
 * 先頭の回数（`3 2d6`）を `x3` に直し、システムのコマンドの形に合うものだけを振り、
 * 結果の文面を同じ形に整える。text は全角を半角に直したもの（Axe が直してから送る）
 */
export const rollLine = async (gameType: string, text: string): Promise<Rolled | null> => {
  const match = /^((\d+)?\s+)?(.*)?/i.exec(text) as RegExpExecArray;
  const repeat = match[2] !== undefined ? Number(match[2]) : 1;
  let command = match[3] ?? text;
  const system =
    (await loadGameSystem(gameType)) ??
    ((await loadGameSystem(PLAIN_DICE_BOT)) as NonNullable<
      Awaited<ReturnType<typeof loadGameSystem>>
    >);
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
    // 繰り返しのロールを行ごとに並べ、見出しの直後の改行を除く
    .replace(/\n*(#\d+)\n/gi, '\n$1 ')
    .replace(/: \n/, ': ')
    .replace(/[＞]/g, '→')
    .trim();
  // 3つ以上の段を経る結果は、段ごとに行を分ける
  if (formatted.split(' → ').length > 3) formatted = formatted.replace(/ → /g, '\n→ ');
  return { text: formatted, secret: result.secret, dicebot: encodeDetail(system.ID, result) };
};
