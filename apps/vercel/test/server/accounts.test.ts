import { describe, expect, it } from 'vitest';

import { ACCOUNT_USER_ID_PREFIX } from '../../contracts/protocol.js';
import { sha256 } from '../../src/core/auth/secrets.js';
import type { Profile, Secret } from '../../src/core/auth/secrets.js';
import { redisAccount } from '../../src/server/accounts.js';
import type { KeyOf } from '../../src/server/redis.js';
import { freshKey, useRedis } from './redis-helpers.js';

const connection = useRedis();

const VERIFIER = 'verifier-for-tests-0123456789-abcdefghijklmnopq';

const profile = (
  name = 'Kai',
  avatarUrl: string | null = 'https://cdn.example/a.png',
): Profile => ({
  accountKey: 'discord:42',
  name,
  avatarUrl,
});

/** ログインを始めて、コードとその人の置き場所を返す */
const signedIn = async (key: KeyOf = freshKey(), who = profile()) => {
  const account = redisAccount(connection.redis, key, who.accountKey);
  const code = await account.signIn(who, await sha256(VERIFIER));
  return { key, account, code };
};

const loggedIn = async () => {
  const { key, account, code } = await signedIn();
  const session = await account.redeem(code, VERIFIER);
  return { key, account, refreshToken: session?.refreshToken as Secret };
};

describe('a Redis account', () => {
  it('keeps the profile, and the user ID it was first given', async () => {
    const { key, account } = await signedIn();
    const first = await account.account();
    await account.signIn(profile('Kai Again', null), 'challenge');

    const again = await account.account();

    expect(first?.userId.startsWith(ACCOUNT_USER_ID_PREFIX)).toBe(true);
    expect(again).toEqual({ userId: first?.userId, name: 'Kai Again', avatarUrl: null });
    expect(redisAccount(connection.redis, key, 'discord:nobody')).toBeDefined();
    expect(await redisAccount(connection.redis, key, 'discord:nobody').account()).toBeNull();
  });

  it('turns a login code into a session once, and only with its verifier', async () => {
    const { account, code } = await signedIn();

    const wrong = await account.redeem(code, 'another-verifier-0123456789-abcdefghijklmnop');
    const { code: second } = await signedIn();
    const session = await redisAccount(connection.redis, freshKey(), 'discord:42').redeem(
      second,
      VERIFIER,
    );

    expect(wrong).toBeNull();
    expect(await account.redeem(code, VERIFIER)).toBeNull();
    expect(session).toBeNull();
  });

  it('hands a session for a fresh code, and not for one whose secret is wrong or that ran out', async () => {
    const { key, account, code } = await signedIn();
    const { code: late } = await signedIn(key);
    const { code: forged } = await signedIn(key);
    await connection.redis.hSet(key('acct', 'discord:42', 'code', late.id), 'expiresAt', '0');

    const session = await account.redeem(code, VERIFIER);

    expect(session?.accountKey).toBe('discord:42');
    expect(session?.account).toEqual(await account.account());
    expect(await account.redeem(late, VERIFIER)).toBeNull();
    expect(await account.redeem({ ...forged, secret: 'wrong' }, VERIFIER)).toBeNull();
  });

  it('hands nothing for a code whose account is gone', async () => {
    const { key, account, code } = await signedIn();
    await connection.redis.del(key('acct', 'discord:42', 'profile'));

    expect(await account.redeem(code, VERIFIER)).toBeNull();
  });

  it('takes the codes away with the account', async () => {
    const { account, code } = await signedIn();
    expect(await account.erase((await account.account())?.userId as string)).toBe(true);

    expect(await account.redeem(code, VERIFIER)).toBeNull();
  });

  it('swaps a refresh token for a new one of the same line, and drops the line when one comes back', async () => {
    const { account, refreshToken } = await loggedIn();

    const next = await account.refresh(refreshToken);
    const replayed = await account.refresh(refreshToken);

    expect(next?.refreshToken.id).not.toBe(refreshToken.id);
    expect(replayed).toBeNull();
    expect(await account.refresh(next?.refreshToken as Secret)).toBeNull();
  });

  it('takes a refresh token sent twice at once only once', async () => {
    const { account, refreshToken } = await loggedIn();

    const answers = await Promise.all([
      account.refresh(refreshToken),
      account.refresh(refreshToken),
    ]);
    const winner = answers.find((answer) => answer !== null);

    expect(answers.filter((answer) => answer === null)).toHaveLength(1);
    expect(await account.refresh(winner?.refreshToken as Secret)).toBeNull();
  });

  it('turns away a refresh token that is unknown, wrong, or ran out', async () => {
    const { key, account, refreshToken } = await loggedIn();
    const family = (await connection.redis.get(
      key('acct', 'discord:42', 'rt', refreshToken.id),
    )) as string;

    expect(await account.refresh({ id: 'nope', secret: 'nope' })).toBeNull();
    expect(await account.refresh({ ...refreshToken, secret: 'wrong' })).toBeNull();
    await connection.redis.hDel(key('acct', 'discord:42', 'fam', family), refreshToken.id);
    expect(await account.refresh(refreshToken)).toBeNull();

    const { account: other, refreshToken: stale } = await loggedIn();
    const staleKey = (await connection.redis.keys(`*rt:${stale.id}`))[0];
    const staleFamily = (await connection.redis.get(staleKey)) as string;
    const familyKey = staleKey.replace(`rt:${stale.id}`, `fam:${staleFamily}`);
    const entry = JSON.parse((await connection.redis.hGet(familyKey, stale.id)) as string);
    await connection.redis.hSet(familyKey, stale.id, JSON.stringify({ ...entry, expiresAt: 0 }));
    expect(await other.refresh(stale)).toBeNull();
  });

  it('ends the line on logout, and does nothing for a token it does not know', async () => {
    const { account, refreshToken } = await loggedIn();

    await account.signOut({ id: 'nope', secret: 'nope' });
    await account.signOut(refreshToken);

    expect(await account.refresh(refreshToken)).toBeNull();
  });

  it('erases the account, but not for the user ID of an account made again', async () => {
    const { key, account, refreshToken } = await loggedIn();
    const userId = (await account.account())?.userId as string;

    expect(await account.erase('acct_someone-else')).toBe(false);
    expect(await account.erase(userId)).toBe(true);

    expect(await account.account()).toBeNull();
    expect(await account.refresh(refreshToken)).toBeNull();
    expect(await connection.redis.keys(key('acct', 'discord:42', '*'))).toEqual([
      key('acct', 'discord:42', 'rt', refreshToken.id),
    ]);
  });
});
