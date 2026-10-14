const encoder = new TextEncoder();

export const encodeText = (text: string): Uint8Array<ArrayBuffer> =>
  encoder.encode(text) as Uint8Array<ArrayBuffer>;

export const encodeData = (data: ArrayBuffer | string): Uint8Array<ArrayBuffer> =>
  typeof data === 'string' ? encodeText(data) : new Uint8Array(data);
