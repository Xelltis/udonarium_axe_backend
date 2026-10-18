import { nullish, object, safeParse, string } from 'valibot';

import type { LoginConfig } from '../config/login.js';
import type { Profile } from './secrets.js';

const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const CURRENT_USER_URL = 'https://discord.com/api/v10/users/@me';
const AVATAR_URL = 'https://cdn.discordapp.com/avatars';

const tokenSchema = object({ access_token: string() });

const userSchema = object({
  id: string(),
  username: string(),
  global_name: nullish(string()),
  avatar: nullish(string()),
});

/** Discord's consent screen. It asks only for identify, not for the email address or the list of servers. */
export const authorizeUrl = (login: LoginConfig, redirectUri: string, state: string): string => {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: login.discordClientId,
    scope: 'identify',
    redirect_uri: redirectUri,
    state,
  }).toString();
  return url.toString();
};

/**
 * Writes to the log where and why Discord turned a login down, and gives null. Discord's answer
 * names the reason (invalid_grant for a code used twice or a redirect URL that is not the one the
 * code was given for, invalid_client for a wrong secret) and holds no code or token.
 */
const turnedDown = async (step: string, response?: Response): Promise<null> => {
  const why = response ? `: ${response.status} ${(await response.text()).slice(0, 200)}` : '';
  console.error(`Discord turned the login down at ${step}${why}`);
  return null;
};

/**
 * Uses the code that came back from Discord to get the person's details. Null when that fails.
 *
 * The Discord access token is used only to read the person's details once, and is kept nowhere.
 */
export const fetchProfile = async (login: LoginConfig, code: string, redirectUri: string): Promise<Profile | null> => {
  const tokenResponse = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${login.discordClientId}:${login.discordClientSecret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResponse.ok) return turnedDown('the token request', tokenResponse);
  const token = safeParse(tokenSchema, await tokenResponse.json());
  if (!token.success) return turnedDown('the token answer, which had no access_token');

  const userResponse = await fetch(CURRENT_USER_URL, {
    headers: { Authorization: `Bearer ${token.output.access_token}` },
  });
  if (!userResponse.ok) return turnedDown('the user request', userResponse);
  const user = safeParse(userSchema, await userResponse.json());
  if (!user.success) return turnedDown('the user answer, which was not a user');

  const { id, username, global_name: globalName, avatar } = user.output;
  return {
    accountKey: `discord:${id}`,
    name: globalName ?? username,
    avatarUrl: avatar ? `${AVATAR_URL}/${id}/${avatar}.png` : null,
  };
};
