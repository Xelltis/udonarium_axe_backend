import { afterEach, describe, expect, it, vi } from 'vitest';

import http from '../../contracts/fixtures/http.json' with { type: 'json' };
import { MAX_REPORT_REASON_LENGTH } from '../../contracts/protocol.js';
import type { ReportResponse } from '../../contracts/protocol.js';
import { ASSET_TOKEN_SECONDS, signToken } from '../../src/core/auth/tokens.js';
import type { Activity } from '../../src/core/moderation/activity.js';
import type { Report } from '../../src/core/moderation/reports.js';
import { harness } from '../harness.js';
import { callAdmin } from './admin-helpers.js';
import {
  ADMIN_ID,
  ORIGIN,
  OTHER_ROOM_KEY,
  ROOM_KEY,
  SESSION_SECRET,
  assetTokenFor,
  freshIp,
  jsonOf,
  shapeOf,
  withinOneWindow,
} from './helpers.js';
import { ROOMS, eventually } from './room-helpers.js';

// Reports from a room's seats to the operator: who made each is kept with it, so that false reports
// can be told apart, and the operator sets what came of them.

afterEach(() => {
  vi.restoreAllMocks();
});

const SHA = 'a'.repeat(64);

const report = (body: unknown, options: { token?: string; ip?: string; room?: string } = {}) =>
  harness.fetch(
    new Request(`${ROOMS}/${options.room ?? ROOM_KEY}/reports`, {
      method: 'POST',
      headers: {
        Origin: ORIGIN,
        'Content-Type': 'application/json',
        'CF-Connecting-IP': options.ip ?? freshIp(),
        ...(options.token === '' ? {} : { Authorization: `Bearer ${options.token ?? assetTokenFor('pl')}` }),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  );

const reports = async () => (await jsonOf<{ reports: Report[] }>(await callAdmin('reports'))).reports;

const noted = (match: (entry: Activity) => boolean) =>
  eventually(
    async () => (await jsonOf<{ activity: Activity[] }>(await callAdmin('activity'))).activity,
    (entries) => entries.some(match)
  ).then((entries) => entries.filter(match));

describe('a report from a seat of the room', () => {
  it('is kept with who made it, as the example says, from a player and from a guest alike', async () => {
    const ip = freshIp();
    const fromPlayer = await report(http.reportRequest, { ip });
    expect(fromPlayer.status).toBe(201);
    const { id } = await jsonOf<ReportResponse>(fromPlayer);
    expect(shapeOf({ id })).toEqual(shapeOf(http.reportResponse));
    const fromGuest = await report(
      { target: 'room', reason: '  部屋の名前がひどい  ' },
      { token: assetTokenFor('guest') }
    );
    const guestId = (await jsonOf<ReportResponse>(fromGuest)).id;

    const kept = await reports();
    expect(kept.find((each) => each.id === id)).toEqual({
      id,
      at: expect.any(Number),
      roomKey: ROOM_KEY,
      target: 'asset',
      assetId: http.reportRequest.assetId,
      reason: http.reportRequest.reason,
      reporter: { address: ip, discordId: null, userId: expect.any(String), role: 'pl' },
      status: 'open',
      handledAt: null,
      handledBy: null,
    });
    expect(kept.find((each) => each.id === guestId)).toMatchObject({
      target: 'room',
      assetId: null,
      reason: '部屋の名前がひどい',
      reporter: { role: 'guest' },
    });
  });

  it('keeps the reporter’s Discord account when the seat came in logged in, and turns one banned away', async () => {
    const discordId = `7${String(Date.now()).padStart(17, '0')}`;
    const token = signToken<'asset'>(
      { aud: 'asset', room: ROOM_KEY, role: 'pl', uid: 'acct_reporter', sub: `discord:${discordId}` },
      ASSET_TOKEN_SECONDS,
      SESSION_SECRET
    );
    const { id } = await jsonOf<ReportResponse>(
      await report({ target: 'asset', assetId: SHA, reason: 'x' }, { token })
    );
    expect((await reports()).find((each) => each.id === id)?.reporter).toMatchObject({
      discordId,
      userId: 'acct_reporter',
    });

    const banned = await callAdmin('bans', { method: 'POST', body: { kind: 'discord', value: discordId } });
    expect(banned.status).toBe(201);
    try {
      expect((await report({ target: 'room', reason: 'x' }, { token })).status).toBe(403);
    } finally {
      await callAdmin(`bans?kind=discord&value=${discordId}`, { method: 'DELETE' });
    }
  });

  it('is turned away in the wrong form, without the room’s token, or too often', async () => {
    const statusOf = async (body: unknown, options = {}) => (await report(body, options)).status;

    expect(await statusOf({ target: 'asset', reason: 'no hash' })).toBe(400);
    expect(await statusOf({ target: 'room', assetId: SHA, reason: 'a hash for a room' })).toBe(400);
    expect(await statusOf({ target: 'asset', assetId: 'nope', reason: 'x' })).toBe(400);
    expect(await statusOf({ target: 'room', reason: '   ' })).toBe(400);
    expect(await statusOf({ target: 'room', reason: 'x'.repeat(MAX_REPORT_REASON_LENGTH + 1) })).toBe(400);
    expect(await statusOf({ target: 'chat', reason: 'x' })).toBe(400);
    expect(await statusOf('{')).toBe(400);
    expect(await statusOf({ target: 'room', reason: 'x' }, { room: 'nope' })).toBe(400);
    expect(await statusOf({ target: 'room', reason: 'x' }, { token: '' })).toBe(401);
    expect(await statusOf({ target: 'room', reason: 'x' }, { room: OTHER_ROOM_KEY })).toBe(401);

    await withinOneWindow(async () => {
      const ip = freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) statuses.push(await statusOf({ target: 'room', reason: `${i}` }, { ip }));
      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
    });
  });
});

describe('what the operator makes of a report', () => {
  it('is set with who set it and when, and written down', async () => {
    const { id } = await jsonOf<ReportResponse>(await report({ target: 'room', reason: 'look' }));

    const done = await callAdmin(`reports/${id}`, { method: 'PUT', body: { status: 'done' } });
    expect((await jsonOf<{ report: Report }>(done)).report).toMatchObject({
      id,
      status: 'done',
      handledBy: ADMIN_ID,
      handledAt: expect.any(Number),
    });
    expect((await reports()).find((each) => each.id === id)?.status).toBe('done');
    expect(await noted((entry) => entry.detail === `report done ${id}`)).toEqual([
      expect.objectContaining({ kind: 'admin', roomKey: ROOM_KEY }),
    ]);

    const missing = '00000000-0000-0000-0000-000000000000';
    expect((await callAdmin(`reports/${missing}`, { method: 'PUT', body: { status: 'open' } })).status).toBe(404);
    expect((await callAdmin('reports/nope', { method: 'PUT', body: { status: 'open' } })).status).toBe(400);
    expect((await callAdmin(`reports/${id}`, { method: 'PUT', body: { status: 'gone' } })).status).toBe(400);
    expect((await callAdmin(`reports/${id}`, { method: 'PUT', body: '{' })).status).toBe(400);
  });
});
