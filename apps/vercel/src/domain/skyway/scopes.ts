import type { ChannelScope } from '@skyway-sdk/token';

export const buildLobbyChannelScope = (peerId: string, lobbySize: number): ChannelScope => ({
  name: `udonarium-lobby-*-of-${lobbySize}`,
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
