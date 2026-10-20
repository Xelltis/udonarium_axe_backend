import type { Context } from 'hono';
import { maxLength, minLength, object, optional, picklist, pipe, regex, safeParse, string, trim } from 'valibot';

import { MAX_REPORT_REASON_LENGTH, REPORT_TARGETS } from '../../../../contracts/protocol.js';
import type { ReportResponse } from '../../../../contracts/protocol.js';
import { ASSET_ID } from '../../assets/keys.js';
import { discordIdOf } from '../../moderation/bans.js';
import type { Report } from '../../moderation/reports.js';
import type { ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { accountBanOf } from '../moderation.js';
import { assetClaimsOf } from '../request.js';

type ReportContext = Context<ServerEnv>;

const reportSchema = object({
  target: picklist(REPORT_TARGETS),
  assetId: optional(pipe(string(), regex(ASSET_ID))),
  reason: pipe(string(), trim(), minLength(1), maxLength(MAX_REPORT_REASON_LENGTH)),
});

/**
 * POST /v1/rooms/:roomKey/reports. A seat of the room, of any role, tells the operator of a picture
 * or sound in it, or of the room, with the room's asset token. Who reported (the address, the
 * account, the seat) is kept with it, so that false reports can be told apart and their senders
 * banned. Counted against the rate limit for rooms, and turned away as over it when the reporter
 * has made MAX_REPORTS_PER_REPORTER in the last day.
 */
export const postReport = async (c: ReportContext) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  const claims = assetClaimsOf(c, config.login, roomKey);
  if (!claims) return fail(c, 401, 'asset-token-required');
  if (await accountBanOf(c, claims.sub)) return fail(c, 403, 'banned');
  const parsed = safeParse(reportSchema, await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, 'invalid-request');
  const { target, assetId, reason } = parsed.output;
  if ((target === 'asset') !== (assetId !== undefined)) return fail(c, 400, 'invalid-request');
  if (!(await backend.limit(c.req.raw, 'room'))) return fail(c, 429, 'rate-limited');

  const report: Report = {
    id: crypto.randomUUID(),
    at: Date.now(),
    roomKey,
    target,
    assetId: assetId ?? null,
    reason,
    reporter: {
      address: backend.addressOf(c.req.raw),
      discordId: discordIdOf(claims.sub),
      userId: claims.uid,
      role: claims.role,
    },
    status: 'open',
    handledAt: null,
    handledBy: null,
  };
  if (!(await backend.moderation.report(report))) return fail(c, 429, 'rate-limited');
  return c.json<ReportResponse>({ id: report.id }, 201);
};
