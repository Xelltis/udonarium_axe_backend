import type { Redis } from '../redis.js';

/** 部屋の持ち主が書く1つの操作。key のほかの引数は args に並べる */
export interface Op {
  command: 'HSET' | 'HDEL' | 'DEL' | 'ZADD' | 'ZREM' | 'SET' | 'SADD' | 'SREM' | 'PEXPIRE';
  key: string;
  args: (string | Buffer)[];
}

/** 1回に送る量の上限。Redis（Upstash など）が1つの要求で受ける大きさより小さくしておく */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * lease がまだ自分のものなら、操作を順に流す。違えば何もせずに 0。
 * KEYS[1] は lease、KEYS[2..] は操作の鍵。ARGV[1] は自分の lease、ARGV[2..] は操作ごとに
 * 「コマンド・鍵の番号・引数の数・引数…」
 */
const FENCED = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local i = 2
while i <= #ARGV do
  local count = tonumber(ARGV[i + 2])
  local args = {}
  for j = 1, count do args[j] = ARGV[i + 2 + j] end
  redis.call(ARGV[i], KEYS[tonumber(ARGV[i + 1])], unpack(args))
  i = i + 3 + count
end
return 1
`;

const sizeOf = (op: Op): number =>
  op.key.length + op.args.reduce((size, arg) => size + arg.length, 0);

/** 1回に送れる量ずつに分ける。1つで上限を超える操作は、それだけで1回にする */
export const batchesOf = (ops: Op[]): Op[][] => {
  const batches: Op[][] = [];
  let size = Infinity;
  for (const op of ops) {
    const opSize = sizeOf(op);
    if (size + opSize > MAX_BATCH_BYTES) {
      batches.push([]);
      size = 0;
    }
    (batches.at(-1) as Op[]).push(op);
    size += opSize;
  }
  return batches;
};

/**
 * 持ち主として書く。lease が自分のものでなくなっていたら（ほかのインスタンスが部屋を取った）、
 * そこで止めて false。分けて送るので、途中で取られたら前半だけが書かれる
 */
export const fencedWrite = async (
  redis: Redis,
  leaseKey: string,
  lease: string,
  ops: Op[],
): Promise<boolean> => {
  for (const batch of batchesOf(ops)) {
    const keys = [leaseKey, ...new Set(batch.map((op) => op.key))];
    const args: (string | Buffer)[] = [lease];
    for (const op of batch) {
      args.push(op.command, String(keys.indexOf(op.key) + 1), String(op.args.length), ...op.args);
    }
    if ((await redis.eval(FENCED, { keys, arguments: args })) !== 1) return false;
  }
  return true;
};
