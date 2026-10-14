import { describe, expect, it } from 'vitest';
import { safeParse } from 'valibot';

import errors from '../contracts/fixtures/errors.json';
import lww from '../contracts/fixtures/lww.json';
import messages from '../contracts/fixtures/messages.json';
import visibility from '../contracts/fixtures/visibility.json';
import { CLOSE_CODE, ERROR_CODES, PROTOCOL_VERSION, judgeUpdate } from '../contracts/protocol';
import type { UpdateVerdict } from '../contracts/protocol';
import type { ObjectContext } from '../contracts/protocol';
import { clientMessageSchema } from '../src/rooms/messages';
import { describe as describeObject, viewKind } from '../src/rooms/visibility';
import type { ViewEntry, Viewer } from '../src/rooms/visibility';

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

  it('speaks the version the examples are written in', () => {
    expect(messages.client.hello.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(messages.server.welcome.protocolVersion).toBe(PROTOCOL_VERSION);
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
