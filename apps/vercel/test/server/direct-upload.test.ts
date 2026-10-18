import { describe, expect, it } from 'vitest';

import type { AssetStoredResponse, UploadTicketResponse } from '../../contracts/protocol.js';
import { MAX_PUT_BYTES } from '../../src/server/assets/backend.js';
import { bucket, harness } from '../harness.js';
import { OGG_HEAD, ROOM_KEY, assetTokenFor, call, fileOf, jsonOf, put, sha256Hex } from '../shared/helpers.js';
import { prepareAssetRooms } from '../shared/room-helpers.js';

// A Vercel Function does not take a request whose body is over 4.5MB. A big sound is uploaded
// straight to the store.

const asPlayer = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${assetTokenFor('pl')}`,
};

describe('a sound too big for one request', () => {
  it('is turned away as a PUT, and kept once put up straight to the store', async () => {
    await prepareAssetRooms();
    const sound = fileOf(OGG_HEAD, MAX_PUT_BYTES + 1);
    const id = await sha256Hex(sound);

    const refused = await put(id, sound);
    const asked = await call(`${id}/uploads`, {
      method: 'POST',
      body: JSON.stringify({ size: sound.byteLength, name: 'theme.ogg' }),
      headers: asPlayer,
    });
    const ticket = await jsonOf<UploadTicketResponse>(asked);
    // Uploads to the target given, in place of the browser.
    await bucket.put(new URL(ticket.upload.url).pathname.slice(1), sound, 'audio/ogg');
    const done = await call(`${id}/uploads/complete`, {
      method: 'POST',
      body: JSON.stringify({ ticket: ticket.ticket }),
      headers: asPlayer,
    });
    const read = await call(id);

    expect(refused.status).toBe(413);
    expect(asked.status).toBe(201);
    expect(await jsonOf<AssetStoredResponse>(done)).toEqual({ id, status: 'stored' });
    expect(await harness.assetStored(ROOM_KEY, id)).toMatchObject({
      type: 'audio/ogg',
      size: sound.byteLength,
    });
    expect(read.headers.get('X-Asset-Name')).toBe('theme.ogg');
    // Comparing 4MB byte by byte is slow, so the hashes are compared.
    expect(await sha256Hex(new Uint8Array(await read.arrayBuffer()))).toBe(id);
    expect(bucket.paths().some((path) => path.startsWith('uploads/'))).toBe(false);
  });
});
