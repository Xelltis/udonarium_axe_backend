import type { PeerRole, ReportTarget } from '../../../contracts/protocol.js';

/** What the operator made of a report. */
export const REPORT_STATUSES = ['open', 'done', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/** How many reports are kept, and for how long (milliseconds, 90 days). Past either, the oldest go. */
export const MAX_REPORTS = 1000;
export const REPORT_MS = 90 * 24 * 60 * 60 * 1000;

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
