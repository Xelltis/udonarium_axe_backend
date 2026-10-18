import type { Redis } from '../redis.js';

/** One operation the room's owner writes. The arguments besides key go in args. */
export interface Op {
  command: 'HSET' | 'HDEL' | 'DEL' | 'ZADD' | 'ZREM' | 'SET' | 'SADD' | 'SREM' | 'PEXPIRE';
  key: string;
  args: (string | Buffer)[];
}

/** The limit on how much is sent at once. Kept below what Redis (Upstash and others) takes in one request. */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024;

/**
 * Runs the operations in order when the lease is still this owner's and the room has not been
 * deleted. Otherwise does nothing and returns 0.
 * KEYS[1] is the lease, KEYS[2] the room's meta, KEYS[3..] the operations' keys. ARGV[1] is this
 * owner's lease, and ARGV[2..] hold, for each operation, "command, key number, argument count,
 * arguments…".
 */
const FENCED = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('EXISTS', KEYS[2]) == 0 or redis.call('HGET', KEYS[2], 'deleting') == '1' then return 0 end
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

const sizeOf = (op: Op): number => op.key.length + op.args.reduce((size, arg) => size + arg.length, 0);

/** Splits into batches that fit in one send. An operation over the limit by itself gets a batch of its own. */
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

/** What is checked when writing as the owner. */
export interface Fence {
  /** The lease's key. */
  lease: string;
  /** The key of the room's meta. Nothing is written when it is missing or marked as being deleted. */
  meta: string;
}

/**
 * Writes as the owner. When the lease is no longer this owner's (another instance took the room),
 * or the room has been deleted, stops there and returns false. The batches go one by one, so when
 * it stops partway, only the first part is written.
 */
export const fencedWrite = async (redis: Redis, fence: Fence, lease: string, ops: Op[]): Promise<boolean> => {
  for (const batch of batchesOf(ops)) {
    const keys = [fence.lease, fence.meta, ...new Set(batch.map((op) => op.key))];
    const args: (string | Buffer)[] = [lease];
    for (const op of batch) {
      args.push(op.command, String(keys.indexOf(op.key) + 1), String(op.args.length), ...op.args);
    }
    if ((await redis.eval(FENCED, { keys, arguments: args })) !== 1) return false;
  }
  return true;
};
