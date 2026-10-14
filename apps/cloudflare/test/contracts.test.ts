import { describe, expect, it } from 'vitest';
import { safeParse } from 'valibot';

import errors from '../contracts/fixtures/errors.json';
import lww from '../contracts/fixtures/lww.json';
import messages from '../contracts/fixtures/messages.json';
import { CLOSE_CODE, ERROR_CODES, PROTOCOL_VERSION, judgeUpdate } from '../contracts/protocol';
import type { UpdateVerdict } from '../contracts/protocol';
import { clientMessageSchema } from '../src/rooms/messages';

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
