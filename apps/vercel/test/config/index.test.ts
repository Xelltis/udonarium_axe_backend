import { parseConfig } from '../../src/config/index.js';
import { AppError } from '../../src/http/errors/app-error.js';

const validRaw = {
  SKYWAY_APP_ID: 'app',
  SKYWAY_SECRET: 'secret',
  ACCESS_CONTROL_ALLOW_ORIGIN: 'https://example.com, https://other.example',
};

describe('parseConfig', () => {
  it('parses required fields and splits CORS origins', () => {
    const cfg = parseConfig(validRaw);
    expect(cfg.skyway.appId).toBe('app');
    expect(cfg.skyway.secret).toBe('secret');
    expect(cfg.skyway.lobbySize).toBe(3);
    expect(cfg.skyway.tokenTtlSeconds).toBe(60 * 60 * 24);
    expect(cfg.cors.allowedOrigins).toEqual(['https://example.com', 'https://other.example']);
    expect(cfg.environment).toBeUndefined();
  });

  it('accepts numeric strings for lobby size and TTL', () => {
    const cfg = parseConfig({
      ...validRaw,
      SKYWAY_UDONARIUM_LOBBY_SIZE: '5',
      SKYWAY_TOKEN_TTL_SECONDS: '3600',
      ENVIRONMENT: 'prod',
    });
    expect(cfg.skyway.lobbySize).toBe(5);
    expect(cfg.skyway.tokenTtlSeconds).toBe(3600);
    expect(cfg.environment).toBe('prod');
  });

  it('accepts numbers directly', () => {
    const cfg = parseConfig({
      ...validRaw,
      SKYWAY_UDONARIUM_LOBBY_SIZE: 4,
      SKYWAY_TOKEN_TTL_SECONDS: 7200,
    });
    expect(cfg.skyway.lobbySize).toBe(4);
    expect(cfg.skyway.tokenTtlSeconds).toBe(7200);
  });

  it('drops empty CORS entries from a trailing comma', () => {
    const cfg = parseConfig({
      ...validRaw,
      ACCESS_CONTROL_ALLOW_ORIGIN: 'https://example.com, ,',
    });
    expect(cfg.cors.allowedOrigins).toEqual(['https://example.com']);
  });

  it('throws AppError when required fields are missing', () => {
    try {
      parseConfig({ ACCESS_CONTROL_ALLOW_ORIGIN: 'https://example.com' });
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('CONFIG_INVALID');
      expect((error as AppError).status).toBe(500);
    }
  });

  it('throws AppError when TTL is out of range', () => {
    expect(() => parseConfig({ ...validRaw, SKYWAY_TOKEN_TTL_SECONDS: 1 })).toThrow(AppError);
  });

  it('throws AppError when lobby size is non-numeric', () => {
    expect(() => parseConfig({ ...validRaw, SKYWAY_UDONARIUM_LOBBY_SIZE: 'abc' })).toThrow(
      AppError,
    );
  });
});
