import { uuid } from '../../../src/infra/crypto/uuid.js';

describe('uuid', () => {
  it('returns an RFC 4122 v4 string', () => {
    const value = uuid();
    expect(typeof value).toBe('string');
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('generates unique values across calls', () => {
    expect(uuid()).not.toBe(uuid());
  });
});
