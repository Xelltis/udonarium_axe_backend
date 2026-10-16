import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { safeParse } from 'valibot';

import errors from '../../contracts/fixtures/errors.json' with { type: 'json' };
import events from '../../contracts/fixtures/events.json' with { type: 'json' };
import limits from '../../contracts/fixtures/limits.json' with { type: 'json' };
import lww from '../../contracts/fixtures/lww.json' with { type: 'json' };
import messages from '../../contracts/fixtures/messages.json' with { type: 'json' };
import visibility from '../../contracts/fixtures/visibility.json' with { type: 'json' };
import * as protocol from '../../contracts/protocol.js';
import {
  AUTHORITY_ONLY_EVENTS,
  CLOSE_CODE,
  ERROR_CODES,
  PROTOCOL_VERSION,
  ROLE_REJECT_REASONS,
  ROLL_REJECT_REASONS,
  judgeUpdate,
} from '../../contracts/protocol.js';
import type { UpdateVerdict } from '../../contracts/protocol.js';
import type { ObjectContext } from '../../contracts/protocol.js';
import * as tokens from '../../src/core/auth/tokens.js';
import {
  clientMessageSchema,
  roleRequestSchema,
  rollRequestSchema,
} from '../../src/core/rooms/messages.js';
import { describe as describeObject, viewKind } from '../../src/core/rooms/visibility.js';
import type { ViewEntry, Viewer } from '../../src/core/rooms/visibility.js';

describe('the LWW contract', () => {
  it.each(lww.cases)('judges $name as $verdict', ({ stored, incoming, deleted, verdict }) => {
    expect(judgeUpdate(stored, incoming, deleted)).toBe(verdict as UpdateVerdict);
  });
});

describe('the message contract', () => {
  it.each(Object.entries(messages.client))('takes the client message %s', (_name, message) => {
    expect(safeParse(clientMessageSchema, message).success).toBe(true);
  });

  it.each(messages.invalid.map((message) => [JSON.stringify(message), message]))(
    'turns away %s',
    (_name, message) => {
      expect(safeParse(clientMessageSchema, message).success).toBe(false);
    },
  );

  it.each(['hello', 'helloWithPassword', 'helloLoggedIn'] as const)(
    'gives %s the peer id Axe makes from its user id, which the room server holds it to',
    (name) => {
      const { peerId, userId } = messages.client[name];
      const digest = protocol.toBase62(
        new Uint8Array(createHash('sha256').update(userId).digest()),
      );

      expect(peerId).toMatch(protocol.ROOM_PEER_ID_PATTERN);
      expect(peerId.slice(0, protocol.PEER_ID_USER_DIGEST_LENGTH)).toBe(
        digest.slice(0, protocol.PEER_ID_USER_DIGEST_LENGTH),
      );
    },
  );

  it('speaks the version the examples are written in', () => {
    expect(messages.client.hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(messages.server.welcome.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe('the event contract', () => {
  it('names the events only the server sends, and every reason it gives', () => {
    expect(events.authorityOnly).toEqual([...AUTHORITY_ONLY_EVENTS]);
    expect(events.roleRejectReasons).toEqual([...ROLE_REJECT_REASONS]);
    expect(events.rollRejectReasons).toEqual([...ROLL_REJECT_REASONS]);
    expect(ROLE_REJECT_REASONS).toContain(events.roleRejected.reason);
    expect(ROLL_REJECT_REASONS).toContain(events.rollRejected.reason);
  });

  it.each(Object.entries(events.rollRequests))('rolls the request %s', (_name, request) => {
    expect(safeParse(rollRequestSchema, request).success).toBe(true);
  });

  it.each(events.invalidRollRequests.map((request) => [request.suffix, request]))(
    'turns away a request with the target %j',
    (_name, request) => {
      expect(safeParse(rollRequestSchema, request).success).toBe(false);
    },
  );

  it('takes the role request', () => {
    expect(safeParse(roleRequestSchema, events.roleRequest).success).toBe(true);
  });
});

describe('the peer id digest', () => {
  it('writes bytes in base62 as Axe does, each leading zero byte as a 0', () => {
    expect(protocol.toBase62(new Uint8Array([0, 0, 1, 2]))).toBe('004a');
    expect(protocol.toBase62(new Uint8Array([0, 255]))).toBe('047');
    expect(protocol.toBase62(new Uint8Array([]))).toBe('');
  });
});

describe('the limit contract', () => {
  it('holds the limits both sides keep', () => {
    const kept = { ...protocol, ...tokens } as unknown as Record<string, unknown>;
    const values = Object.entries(limits).filter(([name]) => name !== 'description');
    for (const [name, value] of values) expect([name, kept[name]]).toEqual([name, value]);
  });
});

describe('the error contract', () => {
  it('lists every code once, with the message the server sends', () => {
    expect(errors.errors.map((error) => error.code)).toEqual([...ERROR_CODES]);
    for (const error of errors.errors) {
      expect(error.message).toEqual({
        type: 'error',
        code: error.code,
        protocolVersion: PROTOCOL_VERSION,
      });
    }
    expect(CLOSE_CODE).toBe(4000);
  });
});

describe('the visibility contract', () => {
  const cases = visibility.cases.flatMap(({ room, identifier, expect: kinds }) =>
    Object.entries(kinds).map(([viewer, kind]) => ({ room, identifier, viewer, kind })),
  );

  it.each(cases)(
    'shows $identifier in $room to $viewer as $kind',
    ({ room, identifier, viewer, kind }) => {
      const objects = visibility.rooms[room as keyof typeof visibility.rooms] as ObjectContext[];
      const entries = new Map<string, ViewEntry>(
        objects.map((o) => [o.identifier, describeObject(o)]),
      );
      const seer = visibility.viewers[viewer as keyof typeof visibility.viewers] as Viewer;
      expect(viewKind(identifier, seer, (id) => entries.get(id) ?? null)).toBe(kind);
    },
  );
});
