import { MAX_MEMBERS, RATE_WINDOW_SECONDS } from '../../../contracts/protocol.js';

/**
 * 変更をまとめて書くまでの間（ミリ秒）。部屋のサーバーが落ちたときに失うのは、最大でこの長さの変更だけ。
 * それも、つなぎ直したときのカタログの交換で戻る（Cloudflare 版では、待っているあいだは Hibernation に入らない）
 */
export const FLUSH_DELAY_MS = 1000;

/** 書いた変更の数を、まとめて記録する間（ミリ秒）。1秒ごとに書くと点が多すぎる */
export const FLUSH_TALLY_MS = 60_000;

/** 1つの接続が RATE_WINDOW_MS のあいだに送れるフレームの数。超えたら切る */
export const RATE_WINDOW_MS = RATE_WINDOW_SECONDS * 1000;
export const MAX_FRAMES_PER_WINDOW = 2000;

/**
 * 人がいるあいだ、部屋を見回る間（ミリ秒）。部屋のサーバーが落ちて接続が切れたときは、出ていく知らせが
 * 来ないので、見回りで本当につながっている人を数え直し、一覧の人数を合わせ、だれもいなければ
 * 消す時計を進め始める
 */
export const OCCUPIED_CHECK_MS = 60 * 60 * 1000;

/** hello の前のものも含めて、1つの部屋が受ける接続の数 */
export const MAX_SOCKETS = MAX_MEMBERS * 2;

/** つないでから hello を送るまでに待つ時間（ミリ秒）。過ぎたものは、新しい接続が来たときに閉じる */
export const HELLO_TIMEOUT_MS = 10_000;

/** 1つの接続が RATE_WINDOW_MS のあいだに送れるイベントの数。1つのフレームに多くのイベントを詰めても数える */
export const MAX_EVENTS_PER_WINDOW = 20_000;

/** 振った結果の時刻を、サーバーの時刻よりどこまで前にしてよいか（ミリ秒）。手元の時計のずれは許す */
export const ROLL_TIME_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * 消させなかったものの子孫を、そのあとも消させない時間（ミリ秒）。Axe はタブを消すとき、タブに続けて
 * 中の行を1つずつ消すので、タブを消させなかったあとに中の行だけが消えないように
 */
export const KEEP_FROM_DELETING_MS = 10_000;

/** 部屋全体で振るのを待てるダイスの数。超えたものは振らない */
export const MAX_PENDING_ROLLS = 64;

/** 1つの部屋に置けるオブジェクトの数。超える新しいものは受けない */
export const MAX_OBJECTS = 200_000;

/** 見え方の手がかり（親の識別子と、宛先などの中身）の大きさの上限。超えるものは受けない */
export const MAX_VIEW_BYTES = 16 * 1024;

/** アクセストークンが切れてから、つながっている席を外すまでに待つ時間（ミリ秒）。新しいトークンが届くまでの余裕 */
export const TOKEN_GRACE_MS = 60_000;
