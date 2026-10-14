import {
  buildLobbyChannelScope,
  buildRoomChannelScope,
} from '../../../src/domain/skyway/scopes.js';

describe('buildLobbyChannelScope', () => {
  it('embeds the lobby size in the channel name', () => {
    const scope = buildLobbyChannelScope('peer-1', 7);
    expect(scope.name).toBe('udonarium-lobby-*-of-7');
    expect(scope.actions).toEqual(['read', 'create']);
    expect(scope.members).toHaveLength(1);
    expect(scope.members[0].name).toBe('peer-1');
    expect(scope.members[0].actions).toEqual(['write']);
  });
});

describe('buildRoomChannelScope', () => {
  it('uses the requested channel name and adds wildcard signal member', () => {
    const scope = buildRoomChannelScope('room-42', 'peer-1');
    expect(scope.name).toBe('room-42');
    expect(scope.actions).toEqual(['read', 'create']);
    expect(scope.members).toHaveLength(2);
    expect(scope.members[0].name).toBe('peer-1');
    expect(scope.members[0].publication?.actions).toEqual(['write']);
    expect(scope.members[0].subscription?.actions).toEqual(['write']);
    expect(scope.members[1].name).toBe('*');
    expect(scope.members[1].actions).toEqual(['signal']);
    expect(scope.members[1].publication?.actions).toEqual([]);
    expect(scope.members[1].subscription?.actions).toEqual([]);
  });
});
