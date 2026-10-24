import type { ChannelScope } from './types.js';

/**
 * The start of a lobby channel name. The lobby scope does not allow sending or receiving data, so
 * even when a name that starts with this is asked for as a room, the room scope (which allows
 * sending and receiving) is not given out.
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
