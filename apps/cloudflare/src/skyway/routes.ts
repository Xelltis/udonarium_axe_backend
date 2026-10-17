import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context, MiddlewareHandler } from 'hono';
import { check, maxBytes, minLength, number, object, pipe, regex, safeParse, string, value } from 'valibot';

import { isAllowedOrigin } from '../core/http/origin';
import type { AppEnv } from '../http/context';
import { issueSkywayToken, LOBBY_CHANNEL_PREFIX, skywayConfigOf } from './token';
import type { SkywayConfig } from './token';

/** The most bytes a channelName or peerId may have (the same as the PHP and Vercel versions). */
const MAX_SCOPE_NAME_BYTES = 200;

/**
 * A name put in a SkyWay scope. SkyWay reads "*" in a name as a wildcard that matches any string,
 * and "\" as its escape, so taking them in would widen what the issued token allows past the room
 * and members it was meant for.
 */
const scopeName = pipe(string(), minLength(1), maxBytes(MAX_SCOPE_NAME_BYTES), regex(/^[^*\\]*$/));

const tokenRequestSchema = object({
  formatVersion: pipe(number(), value(1)),
  channelName: pipe(
    scopeName,
    check((name) => !name.startsWith(LOBBY_CHANNEL_PREFIX))
  ),
  peerId: scopeName,
});

type SkywayErrorCode = 'CONFIG_INVALID' | 'ORIGIN_REQUIRED' | 'ORIGIN_FORBIDDEN' | 'VALIDATION_FAILED';

/** An error in the form the SkyWay token routes answer in, which is the PHP and Vercel versions' and not the room server's. */
const failSkyway = (c: Context, status: 400 | 403 | 500, code: SkywayErrorCode, message: string) =>
  c.json({ error: { code, message } }, status);

// The Origin has already been checked by skywayCors below, so this echoes it as it is.
const corsHeaders = cors({
  origin: (origin) => origin,
  allowHeaders: ['Content-Type', 'Accept'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  maxAge: 86_400,
});

/** Takes requests only with an Origin, and only from the Origins allowed, as rooms are. */
const skywayCors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  if (!origin) return failSkyway(c, 400, 'ORIGIN_REQUIRED', 'Origin header is required.');
  if (!isAllowedOrigin(origin, c.var.config.allowedOrigins)) {
    return failSkyway(c, 403, 'ORIGIN_FORBIDDEN', 'Origin is not allowed.');
  }
  return corsHeaders(c, next);
};

/** Answers with the SkyWay app's settings, or says they are missing or wrong when this Worker issues no tokens. */
const withSkyway = (c: Context<AppEnv>, answer: (config: SkywayConfig) => Response | Promise<Response>) => {
  const config = skywayConfigOf(c.env);
  if ('problem' in config) {
    console.error(`SkyWay tokens cannot be issued: set SKYWAY_APP_ID and SKYWAY_SECRET.\n${config.problem}`);
    return failSkyway(c, 500, 'CONFIG_INVALID', 'Server configuration is invalid.');
  }
  return answer(config);
};

const issue = async (c: Context<AppEnv>, config: SkywayConfig) => {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = safeParse(tokenRequestSchema, body);
  if (!parsed.success) return failSkyway(c, 400, 'VALIDATION_FAILED', 'Invalid request body.');
  return c.json({ token: issueSkywayToken(config, parsed.output) }, 200);
};

/**
 * The routes (under /v1) that issue SkyWay tokens, for Axe delivered with SkyWay: the same paths and
 * answers as the PHP and Vercel versions. They work once SKYWAY_APP_ID and SKYWAY_SECRET are set,
 * beside the room server's routes, which need the login settings instead.
 */
export const skywayRoutes = (): Hono<AppEnv> => {
  const routes = new Hono<AppEnv>();
  for (const path of ['/status', '/skyway/*', '/skyway2023/*']) routes.use(path, skywayCors);
  routes.get('/status', (c) => withSkyway(c, () => c.text('OK')));
  routes.post('/skyway/tokens', (c) => withSkyway(c, (config) => issue(c, config)));
  routes.post('/skyway2023/token', (c) =>
    withSkyway(c, (config) => {
      c.header('Deprecation', 'true');
      c.header('Link', '</v1/skyway/tokens>; rel="successor-version"');
      return issue(c, config);
    })
  );
  return routes;
};
