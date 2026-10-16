import { describe, expect, it } from 'vitest';

import type { AssetStoredResponse, UploadTicketResponse } from '../../contracts/protocol.js';
import { MAX_PUT_BYTES } from '../../src/server/assets/backend.js';
import { bucket, harness } from '../harness.js';
import { OGG_HEAD, ROOM_KEY, assetTokenFor, call, fileOf, jsonOf, put, sha256Hex } from '../shared/helpers.js';
import { prepareAssetRooms } from '../shared/room-helpers.js';

// Vercel の Function は、本文が 4.5MB を超える要求を受けない。大きい音声は、置き場所へ直接上げる

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
    // ブラウザの代わりに、渡された先へ上げる
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
    // 4MB を1バイトずつ比べると遅いので、ハッシュで比べる
    expect(await sha256Hex(new Uint8Array(await read.arrayBuffer()))).toBe(id);
    expect(bucket.paths().some((path) => path.startsWith('uploads/'))).toBe(false);
  });
});
