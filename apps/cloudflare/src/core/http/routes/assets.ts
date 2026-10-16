import type { Context } from 'hono';
import { integer, minValue, number, object, optional, pipe, safeParse, string } from 'valibot';

import { ASSET_NAME_HEADER } from '../../../../contracts/protocol.js';
import type {
  AssetStoredResponse,
  RoomAssetListResponse,
  UploadTicketResponse,
} from '../../../../contracts/protocol.js';
import { ASSET_ID, uploadKeyOf } from '../../assets/keys.js';
import { MAX_ANY_BYTES, MAX_BYTES } from '../../assets/limits.js';
import { assetNameOf } from '../../assets/names.js';
import { SNIFF_BYTES, sniff } from '../../assets/sniff.js';
import { joinChunks, readHead, rejoin } from '../../assets/upload.js';
import { UPLOAD_TICKET_SECONDS, readToken, signToken } from '../../auth/tokens.js';
import type { Claims } from '../../auth/tokens.js';
import type { LoginConfig } from '../../config/login.js';
import type { DirectUploads, ServerEnv } from '../backend.js';
import { fail } from '../errors.js';
import { assetClaimsOf, declaredLengthOf } from '../request.js';

type AssetContext = Context<ServerEnv>;

const ticketSchema = object({
  size: pipe(number(), integer(), minValue(1)),
  name: optional(string()),
});

const completeSchema = object({ ticket: string() });

/**
 * Checks whether it may be stored, in the same order for a PUT and for an upload straight to the
 * store. Returns a refusal when it cannot be stored, and the exists response when it is already
 * stored. With count, it also checks the limit counted each time something is stored.
 */
const admit = async (
  c: AssetContext,
  roomKey: string,
  id: string,
  count: boolean
): Promise<Response | Claims<'asset'>> => {
  const { backend, config } = c.var;
  const claims = assetClaimsOf(c, config.login, roomKey);
  if (!claims) return fail(c, 401, 'asset-token-required');
  if (claims.role === 'guest') return fail(c, 403, 'not-a-player');
  if (await backend.assets.blocked(id)) return fail(c, 451, 'blocked');

  // What is already stored is answered without counting, since a client that joins a room checks
  // all the pictures it holds at once.
  if (await backend.assets.exists(roomKey, id)) {
    return c.json<AssetStoredResponse>({ id, status: 'exists' }, 200);
  }

  // A token can be used for 15 minutes, so the room is asked whether it is still there and whether
  // that person has a role that may store.
  const allowed = await backend.rooms.canUpload(roomKey, claims.uid);
  if (allowed === 'room-not-found') return fail(c, 404, 'room-not-found');
  if (allowed === 'not-a-player') return fail(c, 403, 'not-a-player');

  // IPv6 is counted for each /64. Changing addresses alone does not get more.
  if (count && !(await backend.limit(c.req.raw, 'upload'))) return fail(c, 429, 'rate-limited');
  return claims;
};

/**
 * GET and HEAD /v1/rooms/:roomKey/assets/:id. Sent back to whoever holds this room's token
 * (whoever is in the room now).
 * Hono sends HEAD down the GET route too, and throws away the body returned.
 */
export const getRoomAsset = async (c: AssetContext) => {
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  if (!assetClaimsOf(c, c.var.config.login, roomKey)) {
    return fail(c, 401, 'asset-token-required');
  }
  const { assets } = c.var.backend;
  return c.req.method === 'HEAD' ? assets.head(c.req.raw, roomKey, id) : assets.read(c.req.raw, roomKey, id);
};

/** PUT /v1/rooms/:roomKey/assets/:id. Only this room's GM and players can store. */
export const putRoomAsset = async (c: AssetContext) => {
  const { backend } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');

  const length = declaredLengthOf(c);
  if (length === null) return fail(c, 411, 'length-required');
  // A room server with a limit on the size of the body has anything over it uploaded straight to
  // the store.
  if (length > (backend.assets.direct?.maxPutBytes ?? MAX_ANY_BYTES)) {
    return fail(c, 413, 'too-large');
  }

  const claims = await admit(c, roomKey, id, true);
  if (claims instanceof Response) return claims;

  // The type is decided by reading only the start, and the rest flows on to the store as it comes,
  // without being gathered up first.
  const reader = c.req.raw.body?.getReader();
  if (!reader) return fail(c, 415, 'unsupported-type');
  const head = await readHead(reader, SNIFF_BYTES);
  const sniffed = sniff(joinChunks(head).subarray(0, SNIFF_BYTES));
  if (!sniffed) return fail(c, 415, 'unsupported-type');
  if (length > MAX_BYTES[sniffed.kind]) return fail(c, 413, 'too-large');

  // Something whose name does not match its contents is not stored.
  const name = assetNameOf(c.req.header(ASSET_NAME_HEADER) ?? '');
  const stored = await backend.assets.store(roomKey, id, rejoin(head, reader), length, sniffed.type, name);
  if (stored === 'hash-mismatch') return fail(c, 400, 'hash-mismatch');
  // When the room was deleted while the contents flowed in, what the deletion missed is deleted.
  if ((await backend.rooms.canUpload(roomKey, claims.uid)) === 'room-not-found') {
    await backend.assets.discard(roomKey, id);
    return fail(c, 404, 'room-not-found');
  }
  backend.assets.afterStore();
  return c.json<AssetStoredResponse>({ id, status: 'stored' }, 201);
};

/**
 * POST /v1/rooms/:roomKey/assets/:id/uploads. For something that does not fit in the body of a
 * PUT, hands out where to upload it straight to the store. The checks go in the same order as for
 * PUT. The type and the contents are checked once the word comes that the upload is done.
 */
export const requestUpload = async (c: AssetContext) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  const direct = backend.assets.direct;
  if (!direct) return fail(c, 404, 'not-found');
  const parsed = safeParse(ticketSchema, await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, 'invalid-request');
  const { size } = parsed.output;
  if (size > MAX_ANY_BYTES) return fail(c, 413, 'too-large');

  const claims = await admit(c, roomKey, id, true);
  if (claims instanceof Response) return claims;

  const path = uploadKeyOf(roomKey, id, crypto.randomUUID());
  const upload = await direct.target(path, size);
  // The room server remembers nothing. The word that the upload is done has to come with this
  // ticket.
  const ticket = signToken<'upload'>(
    {
      aud: 'upload',
      room: roomKey,
      id,
      uid: claims.uid,
      size,
      name: assetNameOf(parsed.output.name ?? ''),
      path,
    },
    UPLOAD_TICKET_SECONDS,
    (config.login as LoginConfig).sessionSecret
  );
  return c.json<UploadTicketResponse>({ ticket, upload }, 201);
};

/**
 * POST /v1/rooms/:roomKey/assets/:id/uploads/complete. Checks what was uploaded and makes it a
 * room asset.
 * After the check (whether it could be stored or not), the waiting upload is deleted.
 */
export const completeUpload = async (c: AssetContext) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  const id = c.req.param('id') as string;
  if (!ASSET_ID.test(id)) return fail(c, 400, 'invalid-id');
  const direct = backend.assets.direct;
  if (!direct) return fail(c, 404, 'not-found');
  const parsed = safeParse(completeSchema, await c.req.json().catch(() => null));
  if (!parsed.success) return fail(c, 400, 'invalid-request');

  const claims = assetClaimsOf(c, config.login, roomKey);
  if (!claims) return fail(c, 401, 'asset-token-required');
  // Only a ticket given to this person, for this asset in this room, is taken.
  const secret = (config.login as LoginConfig).sessionSecret;
  const ticket = readToken(parsed.output.ticket, 'upload', secret);
  if (!ticket || ticket.room !== roomKey || ticket.id !== id || ticket.uid !== claims.uid) {
    return fail(c, 400, 'invalid-request');
  }
  try {
    return await keepUpload(c, direct, roomKey, ticket);
  } finally {
    await direct.discard(ticket.path);
  }
};

/**
 * Checks the waiting upload and makes it a room asset. The checks go in the same order, with the
 * same answers, as for PUT.
 */
const keepUpload = async (
  c: AssetContext,
  direct: DirectUploads,
  roomKey: string,
  ticket: Claims<'upload'>
): Promise<Response> => {
  const { backend } = c.var;
  const { id } = ticket;
  const admitted = await admit(c, roomKey, id, false);
  if (admitted instanceof Response) return admitted;

  const body = await direct.open(ticket.path);
  if (!body) return fail(c, 404, 'not-found');
  const reader = body.getReader();
  const head = await readHead(reader, SNIFF_BYTES);
  const sniffed = sniff(joinChunks(head).subarray(0, SNIFF_BYTES));
  if (!sniffed) {
    await reader.cancel();
    return fail(c, 415, 'unsupported-type');
  }
  if (ticket.size > MAX_BYTES[sniffed.kind]) {
    await reader.cancel();
    return fail(c, 413, 'too-large');
  }

  const stored = await backend.assets.store(roomKey, id, rejoin(head, reader), ticket.size, sniffed.type, ticket.name);
  if (stored === 'hash-mismatch') return fail(c, 400, 'hash-mismatch');
  // When the room was deleted during the check, what the deletion missed is deleted.
  if ((await backend.rooms.canUpload(roomKey, admitted.uid)) === 'room-not-found') {
    await backend.assets.discard(roomKey, id);
    return fail(c, 404, 'room-not-found');
  }
  backend.assets.afterStore();
  return c.json<AssetStoredResponse>({ id, status: 'stored' }, 201);
};

/**
 * GET /v1/rooms/:roomKey/assets. Sends the list of assets stored in that room to whoever holds
 * this room's token.
 * This lets someone who joins the room fetch what is in no one's catalog but is still left in the
 * room.
 */
export const listRoomAssets = async (c: AssetContext) => {
  const { backend, config } = c.var;
  const roomKey = c.req.param('roomKey') as string;
  if (!assetClaimsOf(c, config.login, roomKey)) return fail(c, 401, 'asset-token-required');
  if (!(await backend.limit(c.req.raw, 'read'))) return fail(c, 429, 'rate-limited');
  const response = c.json<RoomAssetListResponse>({ assets: await backend.assets.list(roomKey) });
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
};
