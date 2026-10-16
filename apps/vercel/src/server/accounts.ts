import { ACCOUNT_USER_ID_PREFIX } from '../../contracts/protocol.js';
import type { Account } from '../../contracts/protocol.js';
import {
  LOGIN_CODE_SECONDS,
  REFRESH_TOKEN_SECONDS,
  newLoginCode,
  newRefreshToken,
  nowSeconds,
  sameText,
  sha256,
} from '../core/auth/secrets.js';
import type { IssuedToken, Profile, Secret, Session } from '../core/auth/secrets.js';
import type { AccountPort } from '../core/http/backend.js';
import type { KeyOf, Redis } from './redis.js';

// Keeps the account of one logged-in person in Redis. Does the same as the Cloudflare version's
// AccountDurableObject.
//
//   acct:<key>:profile         HASH  userId (as decided the first time), name, avatarUrl, createdAt,
//                                    updatedAt.
//   acct:<key>:code:<ID>       HASH  hash, challenge, expiresAt. Goes away when it expires.
//   acct:<key>:codes           SET   The code ids (for when the account is deleted).
//   acct:<key>:rt:<ID>         STR   The refresh token's family. Goes away when it expires.
//   acct:<key>:fam:<family>    HASH  id → JSON of {hash, expiresAt, used}.
//   acct:<key>:families        SET   The families.
//
// Secrets are kept as hashes. Expiry is checked with the stored expiresAt (the keys' expiry is for
// tidying up).

const SECOND_MS = 1000;

/** A refresh token in a family. */
interface TokenEntry {
  hash: string;
  expiresAt: number;
  used: boolean;
}

/**
 * Uses a refresh token and swaps it for a new one in the same family.
 * KEYS are the family, the new token and the list of families; ARGV are the used token's id, the
 * new id, the new contents, the expiry (milliseconds) and the family. The read and the write are
 * one step, so that two requests that come at the same time with the same token cannot both get
 * through as if it were unused.
 * When a token already used comes, deletes the whole family and returns -1. 0 when the token is
 * not found. 1 when it was swapped.
 */
const ROTATE = `
local entry = redis.call('HGET', KEYS[1], ARGV[1])
if not entry then return 0 end
local token = cjson.decode(entry)
if token.used then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[3], ARGV[5])
  return -1
end
token.used = true
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(token), ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SET', KEYS[2], ARGV[5], 'PX', ARGV[4])
return 1
`;

export const redisAccount = (redis: Redis, key: KeyOf, accountKey: string): AccountPort => {
  const of = (...parts: string[]) => key('acct', accountKey, ...parts);

  const account = async (): Promise<Account | null> => {
    const profile = await redis.hGetAll(of('profile'));
    if (!profile.userId) return null;
    return {
      userId: profile.userId,
      name: profile.name,
      avatarUrl: profile.avatarUrl || null,
    };
  };

  /** Puts a token made beforehand into a family. */
  const issue = async (family: string, next: IssuedToken): Promise<void> => {
    const ttl = REFRESH_TOKEN_SECONDS * SECOND_MS;
    const entry: TokenEntry = {
      hash: next.hash,
      expiresAt: nowSeconds() + REFRESH_TOKEN_SECONDS,
      used: false,
    };
    await redis
      .multi()
      .hSet(of('fam', family), next.token.id, JSON.stringify(entry))
      .pExpire(of('fam', family), ttl)
      .set(of('rt', next.token.id), family, { expiration: { type: 'PX', value: ttl } })
      .sAdd(of('families'), family)
      .exec();
  };

  /** Makes what is handed out, when the person's profile is there. Null once it has been deleted. */
  const sessionOf = async (next: IssuedToken): Promise<Session | null> => {
    const current = await account();
    return current && { account: current, accountKey, refreshToken: next.token };
  };

  /** The family and contents of an unexpired token whose secret matches. Null when there is none. */
  const findRefreshToken = async (
    token: Secret,
    hash: string
  ): Promise<{ family: string; entry: TokenEntry } | null> => {
    const family = await redis.get(of('rt', token.id));
    if (!family) return null;
    const stored = await redis.hGet(of('fam', family), token.id);
    if (!stored) return null;
    const entry = JSON.parse(stored) as TokenEntry;
    if (entry.expiresAt <= nowSeconds() || !sameText(hash, entry.hash)) return null;
    return { family, entry };
  };

  return {
    account,

    async signIn(profile: Profile, challenge: string): Promise<Secret> {
      const now = String(nowSeconds());
      const code = newLoginCode();
      const codeKey = of('code', code.id);
      await redis
        .multi()
        .hSetNX(of('profile'), 'userId', `${ACCOUNT_USER_ID_PREFIX}${crypto.randomUUID()}`)
        .hSetNX(of('profile'), 'createdAt', now)
        .hSet(of('profile'), {
          name: profile.name,
          avatarUrl: profile.avatarUrl ?? '',
          updatedAt: now,
        })
        .hSet(codeKey, {
          hash: await sha256(code.secret),
          challenge,
          expiresAt: String(nowSeconds() + LOGIN_CODE_SECONDS),
        })
        .pExpire(codeKey, LOGIN_CODE_SECONDS * SECOND_MS)
        .sAdd(of('codes'), code.id)
        .exec();
      return code;
    },

    async redeem(code: Secret, verifier: string): Promise<Session | null> {
      const codeKey = of('code', code.id);
      // It can be used only once. It is deleted even when it does not match.
      const [stored] = (await redis
        .multi()
        .hGetAll(codeKey)
        .del(codeKey)
        .sRem(of('codes'), code.id)
        .exec()) as unknown as [Record<string, string>];
      if (!stored.hash) return null;
      const valid =
        Number(stored.expiresAt) > nowSeconds() &&
        sameText(await sha256(code.secret), stored.hash) &&
        sameText(await sha256(verifier), stored.challenge);
      if (!valid) return null;
      const next = await newRefreshToken();
      const session = await sessionOf(next);
      if (session) await issue(crypto.randomUUID(), next);
      return session;
    },

    async refresh(token: Secret): Promise<Session | null> {
      const hash = await sha256(token.secret);
      const next = await newRefreshToken();
      const found = await findRefreshToken(token, hash);
      if (!found) return null;
      const ttl = REFRESH_TOKEN_SECONDS * SECOND_MS;
      const entry: TokenEntry = {
        hash: next.hash,
        expiresAt: nowSeconds() + REFRESH_TOKEN_SECONDS,
        used: false,
      };
      const rotated = await redis.eval(ROTATE, {
        keys: [of('fam', found.family), of('rt', next.token.id), of('families')],
        arguments: [token.id, next.token.id, JSON.stringify(entry), String(ttl), found.family],
      });
      return rotated === 1 ? sessionOf(next) : null;
    },

    async signOut(token: Secret): Promise<void> {
      const found = await findRefreshToken(token, await sha256(token.secret));
      if (!found) return;
      await redis.multi().del(of('fam', found.family)).sRem(of('families'), found.family).exec();
    },

    async erase(userId: string): Promise<boolean> {
      if ((await account())?.userId !== userId) return false;
      const [codes, families] = await Promise.all([redis.sMembers(of('codes')), redis.sMembers(of('families'))]);
      await redis.del([
        of('profile'),
        of('codes'),
        of('families'),
        ...codes.map((id) => of('code', id)),
        ...families.map((family) => of('fam', family)),
      ]);
      return true;
    },
  };
};
