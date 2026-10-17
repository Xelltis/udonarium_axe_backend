import { MAX_MEMBERS, RATE_WINDOW_SECONDS } from '../../../contracts/protocol.js';

/**
 * How long changes gather before they are written together (milliseconds). When the room server goes
 * down, at most this long's worth of changes is lost.
 * Even that comes back through the catalog exchange on reconnecting (in the Cloudflare version, it
 * does not go into hibernation while waiting).
 */
export const FLUSH_DELAY_MS = 1000;

/**
 * How long the count of written changes gathers before it goes into the log (milliseconds). Logging
 * it every second makes too many points.
 */
export const FLUSH_TALLY_MS = 60_000;

/** How many frames one connection may send in RATE_WINDOW_MS. Going over cuts it off. */
export const RATE_WINDOW_MS = RATE_WINDOW_SECONDS * 1000;
export const MAX_FRAMES_PER_WINDOW = 2000;

/**
 * How often the room is checked while people are in it (milliseconds). When connections drop because
 * the room server went down, no word of anyone leaving comes, so the check counts again who is really
 * connected, brings the room list's head count in line, and when nobody is there, starts the clock
 * toward deleting the room.
 */
export const OCCUPIED_CHECK_MS = 60 * 60 * 1000;

/** How many connections one room takes, counting those before their hello. */
export const MAX_SOCKETS = MAX_MEMBERS * 2;

/**
 * How long to wait from connecting to the hello (milliseconds). Those past it are closed when a new
 * connection comes.
 */
export const HELLO_TIMEOUT_MS = 10_000;

/** How many events one connection may send in RATE_WINDOW_MS. They count even when many are packed in one frame. */
export const MAX_EVENTS_PER_WINDOW = 20_000;

/**
 * How far before the server's time the time of a roll's result may be (milliseconds). A local clock
 * being off is allowed for.
 */
export const ROLL_TIME_TOLERANCE_MS = 10 * 60 * 1000;

/**
 * How long, after something was kept from being deleted, its descendants are also kept from being
 * deleted (milliseconds). When Axe deletes a tab, it deletes the lines in it one by one after the tab,
 * so that, after the tab was kept from being deleted, the lines in it do not get deleted on their own.
 * Each delete of them starts it again. Axe sends the lines of a long tab in steps eleven seconds
 * apart, keeping inside the rate window, so this is well longer than that.
 */
export const KEEP_FROM_DELETING_MS = 20_000;

/**
 * How long, after something was last handed back to a seat, a deletion the seat sends of it is told
 * back to the seat (milliseconds). A deletion the seat sent before the object came back to it arrives
 * within the time there and back, behind whatever was on the way; one sent later is the seat's own,
 * and so is the object being gone on its side.
 */
export const HANDED_BACK_MS = 20_000;

/** How many dice can wait to be rolled in the whole room. Any more are not rolled. */
export const MAX_PENDING_ROLLS = 64;

/** How many objects one room can hold. New ones beyond that are not accepted. */
export const MAX_OBJECTS = 200_000;

/**
 * The limit on the size of the clues to visibility (the parent's identifier, and contents such as the
 * addressees). Anything bigger is not accepted.
 */
export const MAX_VIEW_BYTES = 16 * 1024;

/**
 * How long to wait after an access token runs out before removing the seat that is still connected
 * (milliseconds). It leaves time for a new token to arrive.
 */
export const TOKEN_GRACE_MS = 60_000;
