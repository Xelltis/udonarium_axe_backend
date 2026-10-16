import type { LimitKind, ServerBackend } from './core/http/backend';
import { networkOf } from './core/http/network';
import { r2Assets } from './assets/r2';
import { LOBBY_NAME } from './rooms/lobby';

/** 数を絞るものと、その上限を持つバインディング（wrangler.jsonc の ratelimits） */
const LIMITERS = {
  upload: 'UPLOAD_LIMITER',
  read: 'READ_LIMITER',
  room: 'ROOM_LIMITER',
  auth: 'AUTH_LIMITER',
} as const satisfies Record<LimitKind, keyof Env>;

/**
 * Worker の部屋のサーバー。部屋・一覧・アカウントは Durable Object に、部屋のアセットは R2 に置き、
 * 送信元ごとの数はレート制限のバインディングで数える
 */
export const cloudflareBackend = (
  env: Env,
  waitUntil: (work: Promise<unknown>) => void,
): ServerBackend => {
  /**
   * 送信元（IPv6 は /64 ごと）の数が上限のうちか。namespace_id は同じアカウントの Worker どうしで
   * 共有されるので、鍵の頭に受けたホスト名を付けて、同じアカウントに置いた別のインスタンスと
   * 数えるものを混ぜない
   */
  const limit = async (request: Request, kind: LimitKind): Promise<boolean> => {
    const network = networkOf(request.headers.get('CF-Connecting-IP') ?? 'unknown');
    const key = `${new URL(request.url).host}/${network}`;
    return (await env[LIMITERS[kind]].limit({ key })).success;
  };
  const lobby = () => env.LOBBY.getByName(LOBBY_NAME);
  const room = (roomKey: string) => env.ROOMS.getByName(roomKey);

  return {
    limit,
    lobby: {
      list: (userId) => lobby().list(userId),
      find: (roomKey, userId) => lobby().find(roomKey, userId),
    },
    rooms: {
      create: (init) => room(init.roomKey).create(init),
      remove: (roomKey, userId) => room(roomKey).deleteRoom(userId),
      canUpload: (roomKey, userId) => room(roomKey).canUpload(userId),
      connect: (request, roomKey) => room(roomKey).fetch(request),
    },
    account: (accountKey) => env.ACCOUNTS.getByName(accountKey),
    assets: r2Assets(env, waitUntil, limit),
  };
};
