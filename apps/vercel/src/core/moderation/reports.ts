import type { PeerRole, ReportTarget } from '../../../contracts/protocol.js';
import { networkOf, wideNetworkOf } from '../http/network.js';

/** What the operator made of a report. */
export const REPORT_STATUSES = ['open', 'done', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** How many reports are kept, and for how long (milliseconds, 90 days). Past either, the oldest go. */
export const MAX_REPORTS = 1000;
export const REPORT_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * How many reports one reporter may make in REPORTER_MS (a day). Past it they are turned away rather
 * than kept, so that one sender cannot push the reports of others out of the MAX_REPORTS kept.
 */
export const MAX_REPORTS_PER_REPORTER = 20;
export const REPORTER_MS = 24 * 60 * 60 * 1000;

/** A report from a seat of a room, with who made it, so that false reports can be told apart. */
export interface Report {
  id: string;
  /** When it was made (Unix milliseconds). */
  at: number;
  roomKey: string;
  target: ReportTarget;
  /** The SHA-256 of the picture or sound, for target asset; null for the room. */
  assetId: string | null;
  reason: string;
  reporter: {
    address: string;
    /** The Discord user id, when the seat came in logged in. */
    discordId: string | null;
    userId: string;
    role: PeerRole;
  };
  status: ReportStatus;
  /** When the operator last set the status, and who (the Discord user id). Null while it is open as made. */
  handledAt: number | null;
  handledBy: string | null;
}

/**
 * Who a report is counted against: the Discord account when the seat came in logged in, or else the
 * sender, an IPv6 /64 as one, as the rate limits count them.
 */
export const reporterOf = (report: Report): string =>
  report.reporter.discordId === null ? networkOf(report.reporter.address) : `discord:${report.reporter.discordId}`;

/** The start of the rank of a sender not logged in. */
export const ANONYMOUS_RANK = 'anon:';

/**
 * Who a report is counted as past MAX_REPORTS, where the oldest of whoever has kept the most goes,
 * on whichever side holds over half (senders not logged in, or accounts). Senders not logged in are
 * taken together by a wider unit (wideNetworkOf), since many addresses come cheap, and marked anon:.
 */
export const rankOf = (report: Report): string =>
  report.reporter.discordId === null
    ? `${ANONYMOUS_RANK}${wideNetworkOf(report.reporter.address)}`
    : `discord:${report.reporter.discordId}`;
