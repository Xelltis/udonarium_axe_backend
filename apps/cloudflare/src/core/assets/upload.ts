/** ストリームの先頭を、size バイト以上（足りなければ最後まで）読む */
export const readHead = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  size: number
): Promise<Uint8Array[]> => {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (length < size) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  return chunks;
};

/** chunks をつないだもの */
export const joinChunks = (chunks: Uint8Array[]): Uint8Array => {
  const joined = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

/** 先に読んだ chunks と、reader の残りを1本のストリームに戻す */
export const rejoin = (
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
  });
