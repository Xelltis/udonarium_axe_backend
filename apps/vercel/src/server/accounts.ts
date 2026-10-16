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

// ログインした1人ぶんのアカウントを Redis に置く。Cloudflare 版の AccountDurableObject と同じことをする。
//
//   acct:<鍵>:profile         HASH  userId（初めのときに決めたまま）・name・avatarUrl・createdAt・updatedAt
//   acct:<鍵>:code:<ID>       HASH  hash・challenge・expiresAt。期限で消える
//   acct:<鍵>:codes           SET   コードの ID（アカウントを消すときのため）
//   acct:<鍵>:rt:<ID>         STR   リフレッシュトークンの系統。期限で消える
//   acct:<鍵>:fam:<系統>      HASH  ID → {hash, expiresAt, used} の JSON
//   acct:<鍵>:families        SET   系統
//
// 秘密はハッシュにして置く。期限は、置いた expiresAt で確かめる（キーの期限は片付けのため）

const SECOND_MS = 1000;

/** 系統の中のリフレッシュトークン */
interface TokenEntry {
  hash: string;
  expiresAt: number;
  used: boolean;
}

/**
 * リフレッシュトークンを使い、同じ系統の新しいものに替える。
 * KEYS は系統・新しいトークン・系統の一覧、ARGV は使ったトークンの ID・新しい ID・新しい中身・期限（ミリ秒）・系統。読んでから書くまでを1つにし、同じトークンで
 * 同時に来た2つが、どちらも使っていないものとして通らないようにする。
 * もう使ったものが来たら、系統ごと消して -1。見つからなければ 0。替えたら 1
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

  /** 系統に、作っておいたトークンを置く */
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

  /** 人の情報があれば、渡すものを作る。消したあとなら null */
  const sessionOf = async (next: IssuedToken): Promise<Session | null> => {
    const current = await account();
    return current && { account: current, accountKey, refreshToken: next.token };
  };

  /** 期限のうちで、秘密の合うトークンの系統と中身。無ければ null */
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
      // 1度しか使えない。合わなくても消す
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
