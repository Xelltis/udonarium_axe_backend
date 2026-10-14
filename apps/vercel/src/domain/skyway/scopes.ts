import type { ChannelScope } from '@skyway-sdk/token';

/**
 * ロビーのチャンネル名の頭。ロビーのスコープはデータの送受信を許していないので、
 * この頭で始まる名前を部屋として頼まれても、部屋のスコープ（送受信あり）は出さない。
 */
export const LOBBY_CHANNEL_PREFIX = 'udonarium-lobby-';

export const buildLobbyChannelScope = (peerId: string, lobbySize: number): ChannelScope => ({
  name: `${LOBBY_CHANNEL_PREFIX}*-of-${lobbySize}`,
  actions: ['read', 'create'],
  members: [
    {
      name: peerId,
      actions: ['write'],
      publication: { actions: [] },
      subscription: { actions: [] },
    },
  ],
});

export const buildRoomChannelScope = (channelName: string, peerId: string): ChannelScope => ({
  name: channelName,
  actions: ['read', 'create'],
  members: [
    {
      name: peerId,
      actions: ['write'],
      publication: { actions: ['write'] },
      subscription: { actions: ['write'] },
    },
    {
      name: '*',
      actions: ['signal'],
      publication: { actions: [] },
      subscription: { actions: [] },
    },
  ],
});
